export type AdapterConfig = Record<string, unknown>;

export type NormalizedPosition = {
  externalVehicleId: string;
  latitude: number;
  longitude: number;
  speed?: number;
  heading?: number;
  ignition?: boolean;
  address?: string;
  capturedAt: Date;
};

export interface GpsProviderAdapter {
  testConnection(): Promise<{ ok: boolean; message: string }>;
  fetchPositions(): Promise<NormalizedPosition[]>;
  normalizeWebhook(payload: unknown): NormalizedPosition[];
}

function readArray(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.positions)) return payload.positions;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.vehicles)) return payload.vehicles;
  return [];
}

function normalizePosition(item: any): NormalizedPosition | null {
  const latitude = Number(item.latitude ?? item.lat ?? item.position?.latitude);
  const longitude = Number(item.longitude ?? item.lng ?? item.lon ?? item.position?.longitude);
  const externalVehicleId = String(item.externalVehicleId ?? item.vehicleId ?? item.deviceId ?? item.imei ?? item.id ?? '');
  if (!externalVehicleId || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    externalVehicleId,
    latitude,
    longitude,
    speed: item.speed == null ? undefined : Number(item.speed),
    heading: item.heading == null ? undefined : Number(item.heading),
    ignition: item.ignition == null ? undefined : Boolean(item.ignition),
    address: item.address == null ? undefined : String(item.address),
    capturedAt: new Date(item.capturedAt ?? item.timestamp ?? Date.now()),
  };
}

export class MockGpsAdapter implements GpsProviderAdapter {
  async testConnection() { return { ok: true, message: 'Mock GPS adapter is ready' }; }
  async fetchPositions() { return []; }
  normalizeWebhook(payload: unknown) { return readArray(payload).map(normalizePosition).filter((position): position is NormalizedPosition => Boolean(position)); }
}

export class HttpGpsAdapter implements GpsProviderAdapter {
  constructor(private readonly baseUrl: string, private readonly config: AdapterConfig) {}
  private headers() {
    const token = String(this.config.token ?? this.config.apiKey ?? '');
    return { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  }
  private endpoint(name: string, fallback: string) { return String(this.config[name] ?? fallback).replace(/^\//, ''); }
  async testConnection() {
    try {
      const response = await fetch(new URL(this.endpoint('healthEndpoint', ''), `${this.baseUrl.replace(/\/$/, '')}/`), { headers: this.headers() });
      return { ok: response.ok, message: response.ok ? 'Fornecedor respondeu com sucesso' : `Fornecedor respondeu HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Falha de conexão' };
    }
  }
  async fetchPositions() {
    const url = new URL(this.endpoint('positionsEndpoint', 'positions'), `${this.baseUrl.replace(/\/$/, '')}/`);
    const response = await fetch(url, { headers: this.headers() });
    if (!response.ok) throw new Error(`GPS provider returned HTTP ${response.status}`);
    const payload = await response.json();
    return readArray(payload).map(normalizePosition).filter((position): position is NormalizedPosition => Boolean(position));
  }
  normalizeWebhook(payload: unknown) { return readArray(payload).map(normalizePosition).filter((position): position is NormalizedPosition => Boolean(position)); }
}

export function createGpsAdapter(provider: string, baseUrl: string | null, settings: AdapterConfig): GpsProviderAdapter {
  return provider.toLowerCase() === 'mock' || !baseUrl ? new MockGpsAdapter() : new HttpGpsAdapter(baseUrl, settings);
}

export interface BlockerAdapter { sendCommand(externalId: string, action: 'BLOCK' | 'UNBLOCK' | 'STATUS'): Promise<{ ok: boolean; response: string }>; }

export class MockBlockerAdapter implements BlockerAdapter {
  async sendCommand(externalId: string, action: 'BLOCK' | 'UNBLOCK' | 'STATUS') { return { ok: true, response: `mock:${action}:${externalId}` }; }
}

export class HttpBlockerAdapter implements BlockerAdapter {
  constructor(private readonly baseUrl: string, private readonly settings: AdapterConfig) {}
  async sendCommand(externalId: string, action: 'BLOCK' | 'UNBLOCK' | 'STATUS') {
    const token = String(this.settings.token ?? this.settings.apiKey ?? '');
    const response = await fetch(new URL(String(this.settings.commandEndpoint ?? 'commands'), `${this.baseUrl.replace(/\/$/, '')}/`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ deviceId: externalId, command: action }),
    });
    return { ok: response.ok, response: await response.text() };
  }
}

export function createBlockerAdapter(provider: string | null, baseUrl: string | null, settings: AdapterConfig): BlockerAdapter {
  return provider?.toLowerCase() === 'http' && baseUrl ? new HttpBlockerAdapter(baseUrl, settings) : new MockBlockerAdapter();
}
