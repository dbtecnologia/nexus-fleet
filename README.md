# Nexus Fleet

Interface operacional para um SaaS multiempresa de rastreamento veicular.

## Rodar localmente

Para validar a interface sem backend, abra `index.html` em um navegador moderno. O modo demonstração mantém os dados no navegador.

Para usar dados reais, inicie a API e clique no perfil no canto inferior esquerdo para informar a URL, o slug do tenant e as credenciais. A interface então carrega veículos, posições, integrações, cobrança e bloqueadores pela API autenticada; a atualização de posições usa WebSocket quando disponível.

O mapa usa o Google Maps JavaScript API. No mapa operacional, clique em “Ativar Google Maps” e informe uma chave restrita ao domínio do painel. No Google Cloud, habilite billing e a API Maps JavaScript; a chave não é gravada no repositório. Em produção, configure `GOOGLE_MAPS_API_KEY` nas variáveis do Vercel; a rota `/api/maps-config` entrega a chave somente em tempo de execução para o carregador do mapa.

## Backend Node + Prisma

O backend agora está estruturado em `src/` e usa PostgreSQL/PostGIS, Redis, JWT, WebSockets e Stripe. Para executar em uma máquina com Node/npm:

1. Copie `.env.example` para `.env` e troque os segredos.
2. Suba a infraestrutura com `docker compose up -d`.
3. Instale dependências com `pnpm install` (ou `npm install`).
4. Gere o cliente e aplique o banco com `pnpm exec prisma generate` e `pnpm exec prisma migrate dev --name init`.
5. Inicie com `pnpm dev`.

A API fica em `http://localhost:3333/api`, a documentação em `/api/docs`, o JSON OpenAPI em `/api/openapi.json` e o canal WebSocket em `/ws?token=JWT`. O bloqueador usa o adaptador `mock` por padrão; para um fornecedor real, associe `blockerProvider: "http"`, `blockerBaseUrl`, `blockerExternalId` e as configurações criptografadas do dispositivo.

## O que já está funcional

- Dashboard operacional com indicadores, mapa e atividade recente em modo demonstração ou conectado à API.
- Rastreamento com seleção de veículo e painel lateral de detalhes.
- Cadastro de veículos com foto, motorista, telefone e CNH; edição e exclusão com confirmação, validação e persistência pela API quando conectado.
- Cadastro de motoristas com CNH, categoria e validade; edição e exclusão removem o vínculo do condutor com o veículo sem apagar o veículo.
- Área de Motoristas, Clientes, Equipamentos e Relatórios com ações operacionais e exportação CSV.
- Central de Integrações com cadastro, ativação/desativação e teste de conexão via API; sem backend, usa persistência local.
- Módulo Bloqueador com confirmação, motivo obrigatório, comandos reais via adaptador quando conectado e auditoria por veículo.
- Área SaaS com tenant ativo, plano Enterprise, limites de uso, usuários, veículos, integrações e cobrança.
- Menu responsivo, sidebar recolhível e estados responsivos para desktop e celular.
- Versão mobile com menu lateral acessível, áreas de toque ampliadas, safe area para notch, modais em formato de folha e tabelas com rolagem horizontal.
- Modo demonstração explicitamente identificado; nenhuma coordenada real é inventada quando a API não está conectada.

## Publicação

O frontend estático pode ser publicado na Vercel. O backend Express precisa de uma hospedagem Node com PostgreSQL/PostGIS, Redis e as variáveis de `.env.example`; configure `CORS_ORIGIN` com o domínio da Vercel antes de conectar o painel.

