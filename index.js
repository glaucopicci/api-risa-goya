const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

app.post('/revisar', async (req, res) => {
  const { linkTexto, redator, briefing, cliente, tipoJob } = req.body;

  const prompt = `
Você é a Risa, revisora da Goya Conteúdo. Avalie o conteúdo neste link: ${linkTexto}.
Esse conteúdo foi escrito por ${redator} para o cliente ${cliente}. Tipo de job: ${tipoJob}.

Seu papel:
- Revisar ortografia, gramática, coesão, clareza e consistência
- Avaliar se o texto mantém o tom de voz correto conforme brandbook do cliente
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

app.post('/revisar', async (req, res) => {
  const { linkTexto, redator, briefing, cliente, tipoJob } = req.body;

  try {
    const prompt = `
Você é uma revisora experiente chamada Risa da Goya Conteúdo. Recebeu um texto do redator ${redator}, feito para o cliente ${cliente}, no formato ${tipoJob}, com o briefing: "${briefing}".
O texto está neste link: ${linkTexto}
Você deve listar abaixo os pontos de atenção, correções ortográficas, de fluidez, gramática e eventuais sugestões de melhoria.
    `;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'Você é uma revisora experiente chamada Risa da Goya Conteúdo.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.5
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const reply = response.data.choices[0].message.content;
    res.status(200).json({ revisao: reply });
  } catch (error) {
    console.error('Erro na API da Risa:', error.response?.data || error.message);
    res.status(500).send('Erro ao comunicar com o ChatGPT');
  }
});

app.post('/webhook', async (req, res) => {
  const itemId = req.body.item_id;

  try {
    const auth = await axios.post('https://podio.com/oauth/token', {
      grant_type: 'client_credentials',
      client_id: process.env.PODIO_CLIENT_ID,
      client_secret: process.env.PODIO_CLIENT_SECRET
    });

    const podioToken = auth.data.access_token;

    const itemRes = await axios.get(`https://api.podio.com/item/${itemId}`, {
      headers: { Authorization: `OAuth2 ${podioToken}` }
    });

    const fields = itemRes.data.fields;

    const getField = (label) =>
      fields.find((f) => f.label === label)?.values?.[0]?.value || '';

    const linkTexto = getField('Link do Texto');
    const redator = getField('Redator');
    const briefing = getField('Briefing e Links');
    const cliente = getField('Cliente');
    const tipoJob = getField('Job');
    const statusTexto = getField('Status Texto');

    if (statusTexto !== 'Revisar') {
      console.log(`Ignorado: status atual é "${statusTexto}"`);
      return res.status(200).send('Item ignorado, status diferente de Revisar.');
    }

    const revisaoRes = await axios.post('https://risa-api.onrender.com/revisar', {
      linkTexto,
      redator,
      briefing,
      cliente,
      tipoJob
    });

    const respostaRisa = revisaoRes.data.revisao;

    await axios.post(
      `https://api.podio.com/comment/item/${itemId}`,
      { value: `📝 Revisão da Risa:\n\n${respostaRisa}` },
      { headers: { Authorization: `OAuth2 ${podioToken}` } }
    );

    res.status(200).send('Comentário da Risa adicionado com sucesso.');
  } catch (err) {
    console.error('Erro no webhook:', err.response?.data || err.message);
    res.status(500).send('Erro ao processar o webhook.');
  }
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
- Sugerir melhorias sem reescrever diretamente o texto
- Alertar sobre plágio ou estilo desalinhado

Briefing:
${briefing}
  `;

  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Você é uma revisora experiente chamada Risa da Goya Conteúdo." },
        { role: "user", content: prompt }
      ],
      temperature: 0.5
    }, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const reply = response.data.choices[0].message.content;
    return res.status(200).json({ revisao: reply });
  } catch (error) {
    console.error(error.response?.data || error.message);
    return res.status(500).send('Erro ao comunicar com o ChatGPT');
  }
});

const PORT = process.env.PORT || 3000;
app.post('/webhook', async (req, res) => {
  const { item_id, event } = req.body;

  console.log(`Recebido evento ${event} do item ${item_id}`);

  // Em breve: lógica para verificar campo "Revisar" e chamar /revisar

  res.status(200).send('Webhook recebido');
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

