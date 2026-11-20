export const openapi = {
  openapi: '3.0.3',
  info: { title: 'Nexus Fleet API', version: '0.2.0', description: 'API multi-tenant para rastreamento, integrações, bloqueador e cobrança SaaS.' },
  servers: [{ url: '/api' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Position: { type: 'object', required: ['vehicleId', 'latitude', 'longitude', 'capturedAt'], properties: { vehicleId: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, speed: { type: 'number' }, ignition: { type: 'boolean' }, capturedAt: { type: 'string', format: 'date-time' } } },
      Error: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
    },
  },
  paths: {
    '/health': { get: { summary: 'Verifica saúde da API', responses: { '200': { description: 'OK' } } } },
    '/auth/register': { post: { summary: 'Cria tenant e primeiro administrador', responses: { '201': { description: 'Tenant criado' }, '409': { description: 'Slug ou email já usado' } } } },
    '/auth/login': { post: { summary: 'Emite JWT', responses: { '200': { description: 'Autenticado' }, '401': { description: 'Credenciais inválidas' } } } },
    '/vehicles': { get: { security: [{ bearerAuth: [] }], summary: 'Lista veículos do tenant' }, post: { security: [{ bearerAuth: [] }], summary: 'Cria veículo' } },
    '/positions/latest': { get: { security: [{ bearerAuth: [] }], summary: 'Última posição de cada veículo' } },
    '/integrations': { get: { security: [{ bearerAuth: [] }], summary: 'Lista integrações sem segredos' }, post: { security: [{ bearerAuth: [] }], summary: 'Cria integração com credenciais criptografadas' } },
    '/integrations/{id}/test': { post: { security: [{ bearerAuth: [] }], summary: 'Testa conexão do fornecedor' } },
    '/vehicles/{vehicleId}/blocker/commands': { post: { security: [{ bearerAuth: [] }], summary: 'Envia comando de bloqueio ou liberação' } },
    '/billing/checkout': { post: { security: [{ bearerAuth: [] }], summary: 'Cria checkout Stripe' } },
  },
} as const;
