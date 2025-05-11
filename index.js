import express from "express";
import bodyParser from "body-parser";
import { config } from "dotenv";
import OpenAI from "openai";

config();

const app = express();
const port = process.env.PORT || 10000;

app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get("/webhook-debug", (req, res) => {
  console.log("🔍 Debug Podio Webhook:");
  console.log("Headers recebidos:", req.headers);

  res.status(200).send("Debug recebido. Verifique os logs.");
});

// Verificação de webhook do Podio
app.get("/webhook", (req, res) => {
  const verifyToken = req.headers["x-podio-webhook-verify"];
  if (verifyToken) {
    return res
      .status(200)
      .type("text/plain")
      .send(verifyToken.trim());
  }
  return res.status(400).send("Cabeçalho de verificação não encontrado.");
});


// Recebimento do webhook real
app.post("/webhook", async (req, res) => {
  try {
    const item = req.body;

    const cliente = item.cliente || "[Cliente não informado]";
    const redator = item.redator || "[Redator não informado]";
    const tipoJob = item.tipoJob || "[Tipo de job não informado]";
    const briefing = item.briefing || "[Briefing não informado]";

    const systemPrompt = `
Você é a Risa, uma inteligência artificial especializada em revisão e curadoria de textos para marcas. Trabalha como parte do time da Goya Conteúdo.
Seu tom é técnico, coerente com o público-alvo, respeitoso com o estilo do redator, mas sempre comprometido com a clareza e a fluidez. Você nunca inventa dados. Se algo estiver vago, você sinaliza.
O redator é humano, e o texto a seguir foi criado para o cliente ${cliente}, no formato ${tipoJob}, com o briefing: "${briefing}".
Faça uma revisão detalhada e sugira ajustes se necessário, mantendo o estilo e o propósito do texto.
Alerta sobre possibilidade de plágio, tom fora do cliente ou texto gerado por IA.
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: item.texto || "[Texto não enviado]" }
      ],
      temperature: 0.7
    });

    const reply = response.choices[0]?.message?.content;
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

