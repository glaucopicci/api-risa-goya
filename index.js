// index.js otimizado
import express from 'express';
import fetch from 'node-fetch';
import OpenAI from 'openai';
import { google } from 'googleapis';

const app = express();
app.use(express.json());

const {
  PODIO_CLIENT_ID,
  PODIO_CLIENT_SECRET,
  PODIO_REFRESH_TOKEN,
  PODIO_ACCESS_TOKEN: initialAccessToken,
  OPENAI_API_KEY,
  OPENAI_MODEL,
  GOOGLE_CREDENTIALS_JSON
} = process.env;

let podioAccessToken = initialAccessToken;

// ======= Podio OAuth =======
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
  if (!response.ok) throw new Error('Erro ao renovar token: ' + text);

  const data = JSON.parse(text);
  podioAccessToken = data.access_token;
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

// ======= Google Docs =======
async function getGoogleDocContent(docUrl) {
  const cleanUrl = docUrl.split('?')[0];
  const match = cleanUrl.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) return '';
  const docId = match[1];

  const rawCredentials = JSON.parse(GOOGLE_CREDENTIALS_JSON);
  const credentials = {
    ...rawCredentials,
    private_key: rawCredentials.private_key.replace(/\\n/g, '\n')
  };

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/documents.readonly']
  });

  const client = await auth.getClient();
  const docs = google.docs({ version: 'v1', auth: client });
  const doc = await docs.documents.get({ documentId: docId });

  const content = doc.data.body.content || [];
  const paragraphs = content.flatMap(el =>
    el.paragraph?.elements?.map(e => e.textRun?.content.trim()) || []
  );

  return paragraphs.filter(Boolean).join('\n');
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

//iniciaram as mudanças do arquivo funcional para a rota guideline no drive

import path from 'path';

function slugify(str) {
  return str
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove acentos
    .replace(/[^\w\s-]/g, "") // remove pontuação
    .trim()
    .replace(/\s+/g, "-");
}

async function getInstrucoes(clienteNome) {
  const credentials = JSON.parse(GOOGLE_CREDENTIALS_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: {
      ...credentials,
      private_key: credentials.private_key.replace(/\\n/g, '\n')
    },
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  });

  const client = await auth.getClient();
  const drive = google.drive({ version: 'v3', auth: client });

  const slug = slugify(clienteNome);

  // 📄 Lê o guideline geral (guideline-geral.txt)
  const guidelineRes = await drive.files.list({
    q: "name='guideline-geral.txt'",
    fields: 'files(id)',
    pageSize: 1
  });

  const guidelineId = guidelineRes.data.files?.[0]?.id;
  let guideline = '';
  if (guidelineId) {
    const texto = await drive.files.get({ fileId: guidelineId, alt: 'media' }, { responseType: 'text' });
    guideline = texto.data;
  }

  // 📚 Lê o PDF do cliente (brandbooks/slug.pdf)
  const pdfName = `${slug}.pdf`;
  const pdfList = await drive.files.list({
    q: `name='${pdfName}' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1
  });

  let brandbookText = '';
  const pdfFile = pdfList.data.files?.[0];
  if (pdfFile) {
    const pdfLink = `https://drive.google.com/file/d/${pdfFile.id}/view`;
    brandbookText = `📘 Brandbook detectado para ${clienteNome}:\nLink: ${pdfLink}\n\nUse as orientações desse documento ao revisar o texto.`;
  }

  return `${guideline}\n\n${brandbookText}`;
}

//terminaram as mudanças do arquivo funcional para a rota guideline no drive

// ======= ROTA /revisar =======
app.post('/revisar', async (req, res) => {
  const { item_id } = req.body;

  try {
    const item = await podioGet(`item/${item_id}`);
    const getField = (id) => item.fields.find(f => f.external_id === id);

    const statusField = getField('status');
    const optionId = statusField?.values?.[0]?.value?.id;
    if (optionId !== 4) return res.status(204).send(); // não é "Revisar"

    const title = getField('titulo-2')?.values?.[0]?.value || '';
    const cliente = getField('cliente')?.values?.[0]?.value?.title || '';
    const tipoJob = getField('tipo-do-job')?.values?.[0]?.value?.text || '';
    const briefing = getField('observacoes-e-links')?.values?.[0]?.value || '';
    const redator = getField('time-envolvido')?.values?.[0]?.value?.name || '';
    const docField = getField('link-do-texto');
    const docUrl = docField?.values?.[0]?.embed?.url || docField?.values?.[0]?.value || '';
    const texto = docUrl ? await getGoogleDocContent(docUrl) : '';

    console.log(`[${title}] Enviando para revisão...`);

    const model = OPENAI_MODEL || 'gpt-4.1';

//iniciaram as mudanças do arquivo funcional para a rota guideline no drive

    const instrucoes = await getInstrucoes(cliente);

    const prompt = `${instrucoes}

        Título: ${title}
        Cliente: ${cliente}
        Tipo de Job: ${tipoJob}
        Briefing: ${briefing}
        Redator: ${redator}

        Texto:
        ${texto}

        Revise o conteúdo acima conforme as diretrizes da Goya Conteúdo e as instruções do cliente.`;

//terminou as mudanças do arquivo funcional para a rota guideline no drive

    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'Você é a Risa, assistente de revisão da Goya Conteúdo.' },
        { role: 'user', content: prompt }
      ]
    });

    const revisado = completion.choices[0].message.content;
    await podioPost(`comment/item/${item_id}`, { value: revisado });

    console.log(`[${title}] ✅ Comentário postado`);
    res.status(200).send({ revisado });
  } catch (err) {
    console.error('❌ Erro geral:', err.toString());
    res.status(500).send({ error: err.toString() });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Risa rodando na porta ${PORT}`));

