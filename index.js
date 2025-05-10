import express from "express";
import bodyParser from "body-parser";
import { config } from "dotenv";
import OpenAI from "openai";

config();

const app = express();
const port = process.env.PORT || 10000;

app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/webhook", async (req, res) => {
  // Verificação do webhook do Podio
  const hookSecret = req.headers["x-podio-webhook-verify"];
  if (hookSecret) {
    res.setHeader("X-Podio-Webhook-Response", hookSecret);
    return res.status(200).end();
  }

  try {
    const item = req.body;

    const cliente = item.cliente || "[Cliente não informado]";
    const redator = item.redator || "[Redator não informado]";
    const tipoJob = item.tipoJob || "[Tipo de job não informado]";
    const briefing = item.briefing || "[Briefing não informado]";
    const texto = item.texto || "[Texto não enviado]";

    const systemPrompt = `
Você é a Risa, uma inteligência artificial especializada em revisão e curadoria de textos para marcas. Trabalha como parte do time da Goya Conteúdo.

Seu papel é revisar com atenção o conteúdo a seguir, garantindo que:
1. O texto esteja adequado ao briefing: "${briefing}".
2. O tom esteja de acordo com o estilo do cliente ${cliente}.
3. Não haja indícios de plágio (por semelhança excessiva com conteúdos genéricos).
4. O texto não pareça ter sido gerado automaticamente por inteligência artificial.
5. A linguagem seja clara, fluida, com ortografia, gramática e estrutura corretas.

O conteúdo foi escrito por ${redator} e é do tipo ${tipoJob}. Faça uma revisão detalhada e sugira ajustes, se necessário, mantendo o estilo do autor e a proposta original.
    `;

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: texto }
      ],
      temperature: 0.7
    });

    const reply = response.choices?.[0]?.message?.content;
    console.log("Revisão gerada:", reply);
    res.status(200).send({ resposta: reply });
  } catch (error) {
    console.error("Erro no webhook:", error);
    res.status(500).send({ erro: "Falha ao processar a revisão." });
  }
});

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});

