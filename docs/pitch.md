# Roteiro do pitch — cerca de 5 minutos

Grave em modo não listado no YouTube. A demo usa a API no ar (`sh scripts/request.sh` ou os trechos abaixo). Cole o link na seção Vídeo do README.

## 0:00 — Problema (40 s)

A CLYVO VET acompanha o pet entre as consultas. O tutor precisa saber o próximo cuidado, e a clínica precisa que esse cuidado exista no menu dela. Um modelo solto inventa vacina, exame e intervalo. O problema da IA é escolher e explicar o plano sem sair do catálogo.

## 0:40 — Papel da IA (1 min)

A abordagem é GraphRAG com geração restrita.

- O grafo responde o que este pet pode receber: espécie, idade, peso e castração.
- Os embeddings (`gemini-embedding-001`) trazem trechos de diretriz (WSAVA, AAHA, raça, dermatite). Esses trechos entram no prompt que escolhe os ids.
- O `gemini-3.5-flash-lite` devolve só ids do catálogo. Recorrência e duração saem do nó `Treatment`.
- Outra chamada escreve a descrição em português a partir do plano já ancorado. Se o texto citar um item que não está nesse plano, a API descarta a frase e usa o texto montado pelos itens.
- Consulta, medicamento, vacina já aplicada e comportamento chegam no JSON, desviam o cache demográfico e entram na busca e na escolha. A API não guarda o prontuário: quem envia a série é o backend da CLYVO.

## 1:40 — Tutor e clínica (50 s)

Para o tutor, o convite fala da etapa certa e a pergunta fica nessa etapa. Para a clínica, o plano não recomenda produto fora do CSV, e o veterinário assume a conversa quando quiser: o agente para. Para o pet, Labrador, Persa, SRD e um quadro de pele não recebem o mesmo plano.

## 2:30 — Arquitetura (1 min)

Mostre o diagrama do README.

O app chama `POST /v1/care-plan`. A API valida com Zod, filtra o catálogo no Neo4j e busca os chunks. Só então o modelo escolhe os ids. A API faz o grounding e pede a descrição. A resposta leva `carePlan`, `carePlanDescription` e `sources`. Em seguida, `POST /v1/conversations` convida o tutor para uma etapa. O chat usa os mesmos chunks e não agenda horário.

## 3:30 — Demo (1 min 30 s)

Com a API no ar, rode quatro chamadas e leia itens e fontes na tela.

1. Labrador adulto não castrado: vacinas e prevenção do catálogo, com fonte da raça ou da WSAVA.
2. Persa: itens de gato (V5, FeLV ou teste), sem vacina de cão.
3. O mesmo Labrador com diagnóstico de dermatite: o plano inclui Tratamento de dermatite e considera Raspado de pele.
4. Uma pergunta no convite, por exemplo “o que é a V10?”: a resposta fica no item enviado. Se o veterinário escrever na conversa, o agente deixa de responder.

Feche com a frase: o modelo escolhe e explica; o catálogo e o grafo mandam no que pode ser oferecido e em quando repetir.
