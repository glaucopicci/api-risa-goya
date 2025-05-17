import express from 'express';
import fetch from 'node-fetch';
import OpenAI from 'openai';

const app = express();
app.use(express.json());

const {
  PODIO_CLIENT_ID,
  PODIO_CLIENT_SECRET,
  PODIO_REFRESH_TOKEN,
  PODIO_ACCESS_TOKEN: initialAccessToken,
  OPENAI_API_KEY,
  OPENAI_MODEL
} = process.env;

let podioAccessToken = initialAccessToken;

/**
 * Renova o token OAuth do Podio usando form-encoded.
 */
async function refreshAccessToken() {
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('client_id', PODIO_CLIENT_ID);
  params.append('client_secret', PODIO_CLIENT_SECRET);
  params.append('refresh_token', PODIO_REFRESH_TOKEN);

  const response = await fetch('https://podio.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  const text = await response.text();
  if (!response.ok) {
    console.error('❌ Podio token refresh error body:', text);
    throw new Error('Falha ao renovar token: ' + response.status + ' — ' + text);
  }

  const data = JSON.parse(text);
  podioAccessToken = data.access_token;
  console.log('🔄 Token renovado com sucesso.');
  return podioAccessToken;
}

async function podioGet(endpoint) {
  let res = await fetch(`https://api.podio.com/${endpoint}`, {
    headers: { Authorization: `OAuth2 ${podioAccessToken}` }
  });

  if (res.status === 401) {
    await refreshAccessToken();
    res = await fetch(`https://api.podio.com/${endpoint}`, {
      headers: { Authorization: `OAuth2 ${podioAccessToken}` }
    });
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Podio GET falhou: ' + res.status + ' — ' + errText);
  }

  return res.json();
}

async function podioPost(endpoint, body) {
  let res = await fetch(`https://api.podio.com/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `OAuth2 ${podioAccessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (res.status === 401) {
    await refreshAccessToken();
    res = await fetch(`https://api.podio.com/${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `OAuth2 ${podioAccessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Podio POST falhou: ' + res.status + ' — ' + errText);
  }

  return res.json();
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

app.post('/revisar', async (req, res) => {
  const { item_id, revision_id } = req.body;
  console.log(`📥 Recebido do proxy: item_id=${item_id}, revision_id=${revision_id}`);

  try {
    const item = await podioGet(`item/${item_id}`);
    // Instrumentação para inspeção do mapeamento de campos
    console.log('🔍 FIELDS RECEBIDAS:', JSON.stringify(item.fields, null, 2));

    const statusField = item.fields.find(f => f.external_id === 'status');
    const status = statusField?.values?.[0]?.text;

    if (status !== 'Revisar') {
      console.log('⏭️ Status diferente de “Revisar” — ignorando.');
      return res.status(204).send();
    }

    const title = item.fields.find(f => f.external_id === 'title')?.values?.[0]?.text || '';
    const cliente = item.fields.find(f => f.external_id === 'cliente')?.values?.[0]?.text || '';
    const briefing = item.fields.find(f => f.external_id === 'briefing')?.values?.[0]?.text || '';

    const model = OPENAI_MODEL || 'g-67ddadfd22d881919a658cea6d5dc29f-risa';
    console.log(`🤖 Usando modelo: ${model}`);

    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'Você é a Risa, assistente de revisão da Goya Conteúdo.' },
        { role: 'user', content: `Título: ${title}\nCliente: ${cliente}\nBriefing: ${briefing}\n\nPor favor, revise o texto acima conforme as guidelines.` }
      ]
    });

    const revisado = completion.choices[0].message.content;
    await podioPost(`item/${item_id}/comment`, { value: revisado });
    console.log('✅ Comentário publicado no Podio');

    res.status(200).send({ revisado });
  } catch (err) {
    console.error('❌ Erro interno:', err);
    res.status(500).send({ error: err.toString() });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));


