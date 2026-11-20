import 'dotenv/config';
import path from 'node:path';
import http from 'node:http';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { WebSocketServer, WebSocket } from 'ws';
import { Redis } from 'ioredis';
import Stripe from 'stripe';
import { z } from 'zod';
import { Prisma, UserRole, IntegrationProtocol, BlockerCommandAction, CommandStatus, SubscriptionStatus } from '@prisma/client';
import { config } from './config.js';
import { prisma } from './db.js';
import { authenticate, hashPassword, issueAccessToken, requireRole, verifyAccessToken, verifyPassword } from './auth.js';
import { decryptJson, encryptJson, hashToken } from './crypto.js';
import { createBlockerAdapter, createGpsAdapter, type AdapterConfig, type NormalizedPosition } from './adapters.js';
import { openapi } from './openapi.js';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Map<WebSocket, string>();

const redisPublisher = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
const redisSubscriber = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
let redisReady = false;
redisPublisher.on('error', () => undefined);
redisSubscriber.on('error', () => undefined);
void Promise.all([redisPublisher.connect(), redisSubscriber.connect()]).then(async () => {
  redisReady = true;
  await redisSubscriber.subscribe('nexus:fleet-events');
}).catch(() => undefined);
redisSubscriber.on('message', (_channel: string, message: string) => {
  try {
    const event = JSON.parse(message) as { tenantId: string; payload: unknown };
    broadcastTenant(event.tenantId, event.payload);
  } catch { /* malformed events are ignored */ }
});

const stripe = config.STRIPE_SECRET_KEY ? new Stripe(config.STRIPE_SECRET_KEY) : null;
const securityHeaders = helmet as unknown as (options?: { crossOriginResourcePolicy?: false }) => RequestHandler;

app.disable('x-powered-by');
app.use(securityHeaders({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: config.CORS_ORIGIN.split(',').map((value) => value.trim()), credentials: true }));

function broadcastTenant(tenantId: string, payload: unknown) {
  const data = JSON.stringify(payload);
  for (const [client, clientTenantId] of clients) {
    if (clientTenantId === tenantId && client.readyState === WebSocket.OPEN) client.send(data);
  }
}

async function publishEvent(tenantId: string, payload: unknown) {
  broadcastTenant(tenantId, payload);
  if (redisReady) await redisPublisher.publish('nexus:fleet-events', JSON.stringify({ tenantId, payload }));
}

wss.on('connection', (socket, request) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token) return socket.close(1008, 'Missing token');
  try {
    const claims = verifyAccessToken(token);
    clients.set(socket, claims.tenantId);
    socket.send(JSON.stringify({ type: 'connected', tenantId: claims.tenantId }));
    socket.on('close', () => clients.delete(socket));
  } catch {
    socket.close(1008, 'Invalid token');
  }
});

function currentUser(req: Request) {
  if (!req.user) throw new Error('Unauthenticated request');
  return req.user;
}

function routeParam(req: Request, name: string) {
  const value = req.params[name];
  if (!value || Array.isArray(value)) throw new Error(`Missing route parameter: ${name}`);
  return value;
}

function integrationView(integration: Prisma.IntegrationGetPayload<{}>) {
  return {
    id: integration.id,
    name: integration.name,
    provider: integration.provider,
    protocol: integration.protocol,
    baseUrl: integration.baseUrl,
    enabled: integration.enabled,
    lastSyncAt: integration.lastSyncAt,
    lastError: integration.lastError,
    createdAt: integration.createdAt,
    updatedAt: integration.updatedAt,
  };
}

function integrationSettings(integration: { encryptedConfig: string }): AdapterConfig {
  return decryptJson<AdapterConfig>(integration.encryptedConfig);
}

function decimal(value: Prisma.Decimal | null | undefined) { return value == null ? null : Number(value); }

async function persistPositions(tenantId: string, positions: NormalizedPosition[]) {
  let persisted = 0;
  for (const position of positions) {
    const device = await prisma.gpsDevice.findFirst({ where: { tenantId, OR: [{ externalId: position.externalVehicleId }, { imei: position.externalVehicleId }] } });
    if (!device?.vehicleId) continue;
    await prisma.position.create({ data: { tenantId, vehicleId: device.vehicleId, latitude: position.latitude, longitude: position.longitude, speed: position.speed, heading: position.heading, ignition: position.ignition, address: position.address, capturedAt: position.capturedAt } });
    await prisma.gpsDevice.update({ where: { id: device.id }, data: { lastCommunication: new Date() } });
    persisted += 1;
    await publishEvent(tenantId, { type: 'position.updated', vehicleId: device.vehicleId, position });
  }
  return persisted;
}

const registerSchema = z.object({ tenantName: z.string().min(2), tenantSlug: z.string().regex(/^[a-z0-9-]{3,40}$/), name: z.string().min(2), email: z.string().email(), password: z.string().min(8) });
const loginSchema = z.object({ tenantSlug: z.string().min(3), email: z.string().email(), password: z.string().min(1) });
const vehicleSchema = z.object({ plate: z.string().min(3).max(12), brand: z.string().optional(), model: z.string().optional(), year: z.coerce.number().int().optional(), color: z.string().optional(), type: z.string().optional(), driverName: z.string().optional(), driverPhone: z.string().optional(), driverLicense: z.string().optional(), photoUrl: z.string().max(2_000_000).optional(), notes: z.string().optional() });
const deviceSchema = z.object({ vehicleId: z.string().optional(), manufacturer: z.string().optional(), model: z.string().optional(), imei: z.string().min(5), serialNumber: z.string().optional(), externalId: z.string().optional(), protocol: z.string().optional(), blockerProvider: z.string().optional(), blockerExternalId: z.string().optional(), blockerBaseUrl: z.string().url().optional(), blockerSettings: z.record(z.string(), z.unknown()).default({}) });
const integrationSchema = z.object({ name: z.string().min(2), provider: z.string().min(2), protocol: z.nativeEnum(IntegrationProtocol), baseUrl: z.string().url().optional(), settings: z.record(z.string(), z.unknown()).default({}) });
const integrationUpdateSchema = z.object({ enabled: z.boolean().optional(), name: z.string().min(2).optional() }).refine((body) => body.enabled !== undefined || body.name !== undefined, { message: 'no_changes' });
const commandSchema = z.object({ action: z.enum(['BLOCK', 'UNBLOCK', 'STATUS']), reason: z.string().min(3).max(300).optional() });

app.get('/api/health', async (_req, res) => {
  let database = 'ok';
  try { await prisma.$queryRaw`SELECT 1`; } catch { database = 'unavailable'; }
  res.status(database === 'ok' ? 200 : 503).json({ status: database === 'ok' ? 'ok' : 'degraded', database, redis: redisReady ? 'ok' : 'unavailable', time: new Date().toISOString() });
});

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res, next) => {
  if (!stripe || !config.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'stripe_not_configured' });
  try {
    const signature = req.header('stripe-signature');
    if (!signature) return res.status(400).json({ error: 'missing_stripe_signature' });
    const event = stripe.webhooks.constructEvent(req.body, signature, config.STRIPE_WEBHOOK_SECRET);
    const object = event.data.object as any;
    const tenant = object.customer ? await prisma.tenant.findUnique({ where: { stripeCustomerId: String(object.customer) } }) : null;
    if (tenant && event.type === 'invoice.paid') {
      await prisma.invoice.upsert({ where: { stripeInvoiceId: String(object.id) }, update: { status: 'paid', paidAt: new Date() }, create: { tenantId: tenant.id, stripeInvoiceId: String(object.id), amountCents: Number(object.amount_paid ?? 0), currency: String(object.currency ?? 'brl'), status: 'paid', hostedUrl: object.hosted_invoice_url ?? null, paidAt: new Date() } });
    }
    if (tenant && ['customer.subscription.updated', 'customer.subscription.created'].includes(event.type)) {
      await prisma.subscription.update({ where: { tenantId: tenant.id }, data: { stripeSubscriptionId: String(object.id), status: String(object.status).toUpperCase() as SubscriptionStatus, currentPeriodEnd: object.current_period_end ? new Date(Number(object.current_period_end) * 1000) : null } });
    }
    res.json({ received: true });
  } catch (error) { next(error); }
});

app.use(express.json({ limit: '2mb' }));

app.post('/api/auth/register', async (req, res) => {
  const body = registerSchema.parse({ ...req.body, tenantSlug: String(req.body.tenantSlug).toLowerCase(), email: String(req.body.email).toLowerCase() });
  const passwordHash = await hashPassword(body.password);
  const tenant = await prisma.tenant.create({ data: { name: body.tenantName, slug: body.tenantSlug, plan: 'starter' } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, name: body.name, email: body.email, passwordHash, role: UserRole.ADMIN } });
  await prisma.subscription.create({ data: { tenantId: tenant.id, status: SubscriptionStatus.TRIALING, vehicleLimit: 25, userLimit: 5 } });
  const token = issueAccessToken(user);
  await prisma.session.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 15 * 60 * 1000) } });
  res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role }, tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug } });
});

app.post('/api/auth/login', async (req, res) => {
  const body = loginSchema.parse({ ...req.body, tenantSlug: String(req.body.tenantSlug).toLowerCase(), email: String(req.body.email).toLowerCase() });
  const user = await prisma.user.findFirst({ where: { email: body.email, tenant: { slug: body.tenantSlug }, active: true } });
  if (!user || !(await verifyPassword(body.password, user.passwordHash))) return res.status(401).json({ error: 'invalid_credentials' });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  const token = issueAccessToken(user);
  await prisma.session.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 15 * 60 * 1000) } });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role }, tenant: { id: user.tenantId, slug: body.tenantSlug } });
});

app.get('/api/me', authenticate, async (req, res) => {
  const user = await prisma.user.findFirst({ where: { id: currentUser(req).id, tenantId: currentUser(req).tenantId }, include: { tenant: { include: { subscription: true } } } });
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role, tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug, plan: user.tenant.plan, subscription: user.tenant.subscription } });
});

app.get('/api/tenant', authenticate, async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: currentUser(req).tenantId }, include: { subscription: true, _count: { select: { users: true, vehicles: true, integrations: true } } } });
  if (!tenant) return res.status(404).json({ error: 'tenant_not_found' });
  res.json(tenant);
});

app.get('/api/vehicles', authenticate, async (req, res) => {
  const vehicles = await prisma.vehicle.findMany({ where: { tenantId: currentUser(req).tenantId, deletedAt: null }, include: { device: true }, orderBy: { createdAt: 'desc' } });
  res.json(vehicles.map(({ device, ...vehicle }) => ({ ...vehicle, device: device ? (({ blockerEncryptedConfig: _secret, ...safeDevice }) => safeDevice)(device) : null })));
});

app.post('/api/vehicles', authenticate, requireRole(UserRole.ADMIN, UserRole.OPERATOR), async (req, res) => {
  const body = vehicleSchema.parse(req.body);
  const vehicle = await prisma.vehicle.create({ data: { tenantId: currentUser(req).tenantId, ...body } });
  res.status(201).json(vehicle);
});

app.patch('/api/vehicles/:id', authenticate, requireRole(UserRole.ADMIN, UserRole.OPERATOR), async (req, res) => {
  const body = vehicleSchema.partial().parse(req.body);
  const id = routeParam(req, 'id');
  const vehicle = await prisma.vehicle.updateMany({ where: { id, tenantId: currentUser(req).tenantId, deletedAt: null }, data: body });
  if (!vehicle.count) return res.status(404).json({ error: 'vehicle_not_found' });
  res.json(await prisma.vehicle.findFirst({ where: { id, tenantId: currentUser(req).tenantId } }));
});

app.delete('/api/vehicles/:id', authenticate, requireRole(UserRole.ADMIN), async (req, res) => {
  const id = routeParam(req, 'id');
  const result = await prisma.vehicle.updateMany({ where: { id, tenantId: currentUser(req).tenantId, deletedAt: null }, data: { deletedAt: new Date(), status: 'INACTIVE' } });
  if (!result.count) return res.status(404).json({ error: 'vehicle_not_found' });
  res.status(204).send();
});

app.get('/api/devices', authenticate, async (req, res) => {
  const devices = await prisma.gpsDevice.findMany({ where: { tenantId: currentUser(req).tenantId }, include: { vehicle: { select: { id: true, plate: true, model: true } } }, orderBy: { createdAt: 'desc' } });
  res.json(devices.map(({ blockerEncryptedConfig: _secret, ...device }) => device));
});

app.post('/api/devices', authenticate, requireRole(UserRole.ADMIN, UserRole.INSTALLER), async (req, res) => {
  const body = deviceSchema.parse(req.body);
  const tenantId = currentUser(req).tenantId;
  if (body.vehicleId) {
    const vehicle = await prisma.vehicle.findFirst({ where: { id: body.vehicleId, tenantId, deletedAt: null } });
    if (!vehicle) return res.status(404).json({ error: 'vehicle_not_found' });
  }
  const device = await prisma.gpsDevice.create({ data: { tenantId, vehicleId: body.vehicleId, manufacturer: body.manufacturer, model: body.model, imei: body.imei, serialNumber: body.serialNumber, externalId: body.externalId, protocol: body.protocol, blockerProvider: body.blockerProvider, blockerExternalId: body.blockerExternalId, blockerBaseUrl: body.blockerBaseUrl, blockerEncryptedConfig: body.blockerSettings && Object.keys(body.blockerSettings).length ? encryptJson(body.blockerSettings) : null } });
  const { blockerEncryptedConfig: _secret, ...safeDevice } = device;
  res.status(201).json(safeDevice);
});

app.get('/api/positions/latest', authenticate, async (req, res) => {
  const positions = await prisma.position.findMany({ where: { tenantId: currentUser(req).tenantId }, orderBy: { capturedAt: 'desc' }, distinct: ['vehicleId'], include: { vehicle: { select: { id: true, plate: true, model: true, status: true } } } });
  res.json(positions.map((position) => ({ ...position, latitude: decimal(position.latitude), longitude: decimal(position.longitude), speed: decimal(position.speed) })));
});

app.get('/api/integrations', authenticate, async (req, res) => {
  const integrations = await prisma.integration.findMany({ where: { tenantId: currentUser(req).tenantId }, orderBy: { createdAt: 'desc' } });
  res.json(integrations.map(integrationView));
});

app.post('/api/integrations', authenticate, requireRole(UserRole.ADMIN), async (req, res) => {
  const body = integrationSchema.parse(req.body);
  const integration = await prisma.integration.create({ data: { tenantId: currentUser(req).tenantId, name: body.name, provider: body.provider, protocol: body.protocol, baseUrl: body.baseUrl, encryptedConfig: encryptJson(body.settings) } });
  res.status(201).json(integrationView(integration));
});

app.patch('/api/integrations/:id', authenticate, requireRole(UserRole.ADMIN), async (req, res) => {
  const id = routeParam(req, 'id');
  const body = integrationUpdateSchema.parse(req.body);
  const result = await prisma.integration.updateMany({ where: { id, tenantId: currentUser(req).tenantId }, data: body });
  if (!result.count) return res.status(404).json({ error: 'integration_not_found' });
  const integration = await prisma.integration.findFirst({ where: { id, tenantId: currentUser(req).tenantId } });
  res.json(integration ? integrationView(integration) : null);
});

app.post('/api/integrations/:id/test', authenticate, requireRole(UserRole.ADMIN, UserRole.OPERATOR), async (req, res) => {
  const id = routeParam(req, 'id');
  const integration = await prisma.integration.findFirst({ where: { id, tenantId: currentUser(req).tenantId } });
  if (!integration) return res.status(404).json({ error: 'integration_not_found' });
  const adapter = createGpsAdapter(integration.provider, integration.baseUrl, integrationSettings(integration));
  const result = await adapter.testConnection();
  await prisma.integration.update({ where: { id: integration.id }, data: { lastError: result.ok ? null : result.message } });
  res.json(result);
});

app.post('/api/integrations/:id/sync', authenticate, requireRole(UserRole.ADMIN, UserRole.OPERATOR), async (req, res) => {
  const id = routeParam(req, 'id');
  const integration = await prisma.integration.findFirst({ where: { id, tenantId: currentUser(req).tenantId, enabled: true } });
  if (!integration) return res.status(404).json({ error: 'integration_not_found' });
  try {
    const adapter = createGpsAdapter(integration.provider, integration.baseUrl, integrationSettings(integration));
    const positions = await adapter.fetchPositions();
    const persisted = await persistPositions(currentUser(req).tenantId, positions);
    await prisma.integration.update({ where: { id: integration.id }, data: { lastSyncAt: new Date(), lastError: null } });
    res.json({ ok: true, received: positions.length, persisted });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'sync_failed';
    await prisma.integration.update({ where: { id: integration.id }, data: { lastError: message } });
    res.status(502).json({ error: 'integration_sync_failed', message });
  }
});

app.post('/api/webhooks/integrations/:id', async (req, res) => {
  const id = routeParam(req, 'id');
  const integration = await prisma.integration.findUnique({ where: { id } });
  if (!integration) return res.status(404).json({ error: 'integration_not_found' });
  const settings = integrationSettings(integration);
  const expectedSecret = settings.webhookSecret == null ? null : String(settings.webhookSecret);
  if (expectedSecret && req.header('x-integration-secret') !== expectedSecret) return res.status(401).json({ error: 'invalid_webhook_secret' });
  const adapter = createGpsAdapter(integration.provider, integration.baseUrl, settings);
  const positions = adapter.normalizeWebhook(req.body);
  const persisted = await persistPositions(integration.tenantId, positions);
  await prisma.integration.update({ where: { id: integration.id }, data: { lastSyncAt: new Date(), lastError: null } });
  res.status(202).json({ accepted: true, received: positions.length, persisted });
});

app.get('/api/blockers', authenticate, async (req, res) => {
  const devices = await prisma.gpsDevice.findMany({ where: { tenantId: currentUser(req).tenantId }, include: { vehicle: true }, orderBy: { createdAt: 'desc' } });
  res.json(devices.map((device) => ({ id: device.id, vehicle: device.vehicle, installed: Boolean(device.blockerExternalId), provider: device.blockerProvider, lastCommunication: device.lastCommunication })));
});

app.get('/api/vehicles/:vehicleId/blocker/commands', authenticate, async (req, res) => {
  const vehicleId = routeParam(req, 'vehicleId');
  const commands = await prisma.blockerCommand.findMany({ where: { tenantId: currentUser(req).tenantId, vehicleId }, orderBy: { createdAt: 'desc' }, take: 50, include: { user: { select: { name: true, email: true } } } });
  res.json(commands);
});

app.post('/api/vehicles/:vehicleId/blocker/commands', authenticate, requireRole(UserRole.ADMIN, UserRole.OPERATOR), async (req, res) => {
  const body = commandSchema.parse(req.body);
  const user = currentUser(req);
  const vehicleId = routeParam(req, 'vehicleId');
  const vehicle = await prisma.vehicle.findFirst({ where: { id: vehicleId, tenantId: user.tenantId, deletedAt: null }, include: { device: true } });
  if (!vehicle) return res.status(404).json({ error: 'vehicle_not_found' });
  if (!vehicle.device?.blockerExternalId) return res.status(409).json({ error: 'blocker_not_installed' });
  const command = await prisma.blockerCommand.create({ data: { tenantId: user.tenantId, vehicleId: vehicle.id, userId: user.id, action: body.action as BlockerCommandAction, reason: body.reason } });
  try {
    const blockerSettings = vehicle.device.blockerEncryptedConfig ? decryptJson<AdapterConfig>(vehicle.device.blockerEncryptedConfig) : {};
    const adapter = createBlockerAdapter(vehicle.device.blockerProvider, vehicle.device.blockerBaseUrl, blockerSettings);
    const result = await adapter.sendCommand(vehicle.device.blockerExternalId, body.action);
    const updated = await prisma.blockerCommand.update({ where: { id: command.id }, data: { status: result.ok ? CommandStatus.ACKNOWLEDGED : CommandStatus.FAILED, providerResponse: result.response, completedAt: new Date() } });
    await publishEvent(user.tenantId, { type: 'blocker.command.updated', command: updated });
    res.status(202).json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'blocker_command_failed';
    const failed = await prisma.blockerCommand.update({ where: { id: command.id }, data: { status: CommandStatus.FAILED, providerResponse: message, completedAt: new Date() } });
    res.status(502).json(failed);
  }
});

app.get('/api/billing', authenticate, async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: currentUser(req).tenantId }, include: { subscription: true, invoices: { orderBy: { createdAt: 'desc' }, take: 12 }, _count: { select: { users: true, vehicles: true, integrations: true } } } });
  if (!tenant) return res.status(404).json({ error: 'tenant_not_found' });
  res.json(tenant);
});

app.post('/api/billing/checkout', authenticate, requireRole(UserRole.ADMIN), async (req, res) => {
  if (!stripe || !config.STRIPE_PRICE_ENTERPRISE) return res.status(503).json({ error: 'stripe_not_configured' });
  const tenant = await prisma.tenant.findUnique({ where: { id: currentUser(req).tenantId } });
  if (!tenant) return res.status(404).json({ error: 'tenant_not_found' });
  let customerId = tenant.stripeCustomerId;
  if (!customerId) { const customer = await stripe.customers.create({ name: tenant.name, metadata: { tenantId: tenant.id } }); customerId = customer.id; await prisma.tenant.update({ where: { id: tenant.id }, data: { stripeCustomerId: customerId } }); }
  const session = await stripe.checkout.sessions.create({ mode: 'subscription', customer: customerId, line_items: [{ price: config.STRIPE_PRICE_ENTERPRISE, quantity: 1 }], success_url: `${config.PUBLIC_APP_URL}/?billing=success`, cancel_url: `${config.PUBLIC_APP_URL}/?billing=cancelled`, metadata: { tenantId: tenant.id } });
  res.json({ url: session.url });
});

app.post('/api/billing/portal', authenticate, requireRole(UserRole.ADMIN), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'stripe_not_configured' });
  const tenant = await prisma.tenant.findUnique({ where: { id: currentUser(req).tenantId } });
  if (!tenant?.stripeCustomerId) return res.status(409).json({ error: 'stripe_customer_not_found' });
  const session = await stripe.billingPortal.sessions.create({ customer: tenant.stripeCustomerId, return_url: config.PUBLIC_APP_URL });
  res.json({ url: session.url });
});

app.get('/api/openapi.json', (_req, res) => res.json(openapi));
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi));
app.use(express.static(path.resolve(process.cwd()), { dotfiles: 'deny', index: 'index.html' }));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: 'validation_error', details: error.issues });
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return res.status(409).json({ error: 'resource_already_exists' });
  console.error(error instanceof Error ? error.message : error);
  return res.status(500).json({ error: 'internal_server_error' });
});

server.listen(config.PORT, () => console.log(`Nexus Fleet API listening on http://localhost:${config.PORT}`));

async function shutdown(signal: string) {
  console.log(`${signal}: shutting down`);
  await prisma.$disconnect();
  await Promise.allSettled([redisPublisher.quit(), redisSubscriber.quit()]);
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

