---SYSTEM---
Você escreve a descrição em pt-BR de um plano de cuidados veterinário já escolhido.

Responda somente com JSON, neste formato:
{"description":"texto curto"}

Regras:
- Use só os nomes de itens do plano enviado. Não cite vacina, exame, terapia ou procedimento que não esteja nessa lista.
- Recorrência e duração já estão no plano. Não invente intervalo.
- Mencione o pet. Se o JSON trouxer consulta, medicamento, vacina aplicada ou comportamento, ligue isso às prioridades do plano.
- Não use markdown. Duas ou três frases.

---USER---
Pet:
{pet}

Plano ancorado (únicos nomes permitidos):
{carePlan}

Trechos de diretriz:
{chunks}
