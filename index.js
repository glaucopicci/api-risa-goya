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
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

