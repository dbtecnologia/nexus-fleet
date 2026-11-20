# Nexus Fleet

Interface operacional para um SaaS multiempresa de rastreamento veicular.

## Rodar localmente

Abra `index.html` em um navegador moderno. A primeira entrega é estática para permitir validação rápida dos fluxos. Os dados de integrações criados na interface são persistidos no `localStorage` do navegador.

## Backend Node + Prisma

O backend agora está estruturado em `src/` e usa PostgreSQL/PostGIS, Redis, JWT, WebSockets e Stripe. Para executar em uma máquina com Node/npm:

1. Copie `.env.example` para `.env` e troque os segredos.
2. Suba a infraestrutura com `docker compose up -d`.
3. Instale dependências com `pnpm install` (ou `npm install`).
4. Gere o cliente e aplique o banco com `pnpm exec prisma generate` e `pnpm exec prisma migrate dev --name init`.
5. Inicie com `pnpm dev`.

A API fica em `http://localhost:3333/api`, a documentação em `/api/docs`, o JSON OpenAPI em `/api/openapi.json` e o canal WebSocket em `/ws?token=JWT`. O bloqueador usa o adaptador `mock` por padrão; para um fornecedor real, associe `blockerProvider: "http"`, `blockerBaseUrl`, `blockerExternalId` e as configurações criptografadas do dispositivo.

## O que já está funcional

- Dashboard operacional com indicadores, mapa demonstrativo, alertas e atividade recente.
- Rastreamento com seleção de veículo e painel lateral de detalhes.
- Consulta e filtro local de veículos.
- Central de Integrações com cadastro, ativação/desativação, teste de conexão simulado e persistência local.
- Módulo Bloqueador com estado por veículo, comandos simulados, confirmação, auditoria e regras de segurança.
- Área SaaS com tenant ativo, plano Enterprise, limites de uso, usuários, veículos, integrações e cobrança.
- Menu responsivo, sidebar recolhível e estados responsivos para desktop e celular.
- Dados de posição explicitamente marcados como demonstração; nenhuma coordenada real é inventada.

## Próxima camada de produção

O front foi organizado para receber uma API Node/Next com Prisma e PostgreSQL/PostGIS. A implementação de produção deve trocar `demoVehicles` e o armazenamento local por endpoints autenticados, aplicar `tenantId` em todas as consultas, criptografar credenciais de cada integração e publicar adaptadores GPS e de bloqueador por contrato (normalização de posição, evento e comando). Redis, WebSockets, Swagger/OpenAPI, faturamento e a ingestão TCP/UDP entram nessa camada de serviço — não são simulados nesta entrega visual.
