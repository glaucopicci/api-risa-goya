```javascript
import express from 'express';
import fetch from 'node-fetch';
import { Configuration, OpenAIApi } from 'openai';

// Carregando variáveis de ambiente do Render
const PODIO_CLIENT_ID     = process.env.PODIO_CLIENT_ID;
const PODIO_CLIENT_SECRET = process.env.PODIO_CLIENT_SECRET;
const PODIO_REFRESH_TOKEN = process.env.PODIO_REFRESH_TOKEN;
let   PODIO_ACCESS_TOKEN  = process.env.PODIO_ACCESS_TOKEN; // inicial, pode ser renovado
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const RENDER_PORT         = process.env.PORT || 3000;

// Configuração do Express
const app = express();
app.use(express.json());

// Instância do OpenAI
const openai = new OpenAIApi(new Configuration({ apiKey: OPENAI_API_KEY }));

// Função para renovar o token de acesso do Podio
async function refreshAccessToken() {
  console.log('🔄 Renovando Podio access token...');
  const response = await fetch('https://podio.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     PODIO_CLIENT_ID,
      client_secret: PODIO_CLIENT_SECRET,
      refresh_token: PODIO_REFRESH_TOKEN
    })
  });

  if (!response.ok) {
    throw new Error(`Falha ao renovar token: ${response.status}`);
  }
  const data = await response.json();
  PODIO_ACCESS_TOKEN = data.access_token;
  console.log('✅ Novo Podio access token adquirido');
}

// Wrapper para requisições GET ao Podio com retry em 401
async function podioGet(endpoint) {
  const res = await fetch(`https://api.podio.com${endpoint}`, {
    headers: {
      Authorization: `Bearer ${PODIO_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
  if (res.status === 401) {
    await refreshAccessToken();
    return podioGet(endpoint);
  }
  if (!res.ok) {
    throw new Error(`Podio GET ${endpoint} falhou: ${res.status}`);
  }
  return res.json();
}

// Wrapper para requisições POST ao Podio com retry em 401
async function podioPost(endpoint, body) {
  const res = await fetch(`https://api.podio.com${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PODIO_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (res.status === 401) {
    await refreshAccessToken();
    return podioPost(endpoint, body);
  }
  if (!res.ok) {
    throw new Error(`Podio POST ${endpoint} falhou: ${res.status}`);
  }
  return res.json();
}

// Endpoint principal
app.post('/revisar', async (req, res) => {
  try {
    const { item_id, revision_id } = req.body;
    console.log(`📥 Recebido do proxy: item_id=${item_id}, revision_id=${revision_id}`);

    // Busca o item completo no Podio
    const item = await podioGet(`/item/${item_id}`);

    // Localiza o campo de status
    const statusField = item.fields.find(f => f.external_id === 'status');
    const currentStatus = statusField?.values[0]?.value?.text || '';
    if (currentStatus !== 'Revisar') {
      console.log('⏭️ Status diferente de Revisar — ignorando.');
      return res.sendStatus(204);
    }

    // Extrai dados necessários (ajuste external_id conforme seu app)
    const titleField    = item.fields.find(f => f.external_id === 'title');
    const clienteField  = item.fields.find(f => f.external_id === 'cliente');
    const briefingField = item.fields.find(f => f.external_id === 'briefing');

    const titulo   = titleField?.values[0]?.value || '';
    const cliente  = clienteField?.values[0]?.value || '';
    const briefing = briefingField?.values[0]?.value || '';

    // Compondo prompt para a Risa
    const prompt = `Revisar texto de cliente ${cliente} com título “${titulo}” e briefing:
${briefing}`;

    // Chamada à OpenAI
    const completion = await openai.createChatCompletion({
      model:  'g-67ddadfd22d881919a658cea6d5dc29f-risa',
      messages: [
        { role: 'system',   content: 'Você é a Risa, assistente de revisão de textos.' },
        { role: 'user',     content: prompt }
      ]
    });
    const revisao = completion.data.choices[0].message.content;

    // Publica comentário no Podio
    await podioPost(`/comment/item/${item_id}/`, { value: revisao });
    console.log('✅ Comentário publicado no Podio');

    res.status(200).send('Revisão concluída');
  } catch (err) {
    console.error('❌ Erro no /revisar:', err);
    res.status(500).send(err.message);
  }
});

// Inicia o servidor
app.listen(RENDER_PORT, () => {
  console.log(`Servidor rodando na porta ${RENDER_PORT}`);
});
```

