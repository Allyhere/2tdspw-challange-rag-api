# Template de conduta — `api/data/docs/`

Copie o bloco final para `api/data/docs/<slug>-cuidados.md` (ex.: `golden-retriever-cuidados.md`). **Não** grave este arquivo dentro de `docs/`: o seed indexa todo `.md` dessa pasta.

A query de busca é `cachorro da raça Golden Retriever, 28.5kg, 3 anos…` (`species` do JSON: `cachorro` ou `gato`). O seed fatia o corpo em parágrafos separados por **linha em branco** e **descarta trechos com 40 caracteres ou menos**. Cada parágrafo vira um vetor sozinho: título no bloco anterior **não** entra no embedding.

## Por que este formato

| Fazer | Evitar |
| --- | --- |
| 4–7 blocos, 80–500 caracteres, **um** tema cada | Um artigo longo ou 20 seções |
| Começar todo bloco com `Cachorro da raça <raca>` ou `Gato da raça <raca>` | `## Obesidade` sozinho entre linhas em branco (some no corte) |
| `raca` = `breed` do JSON; `especie` = `cachorro` ou `gato` | Raça só no H1; prefixo `Cão` (a query usa `cachorro`) |
| Nomes **exatos** do CSV no mesmo bloco do sinônimo (`vermes` + Vermífugo) | Inventar exame que não está no catálogo |
| Só o que esta raça **muda** | Recopiar WSAVA / AAHA / antirrábica |

`url` do front-matter tem de ser única (MERGE no grafo). Diretriz global: omita `raca` e `especie`; comece o bloco com `Cachorro`, `Gato` ou `Cachorro ou gato` conforme o tema.

Catálogo permitido: V10, V8, Antirrábica, Giárdia, Vermífugo, Hemograma, Exame de fezes, Castração, V5, Vacina FeLV, Teste FIV/FeLV, Avaliação de peso e escore corporal, Ultrassom abdominal, Tratamento de dermatite, Raspado de pele.

Diretriz completa para agentes: `agents.md`.

---

## Cole a partir daqui

```markdown
---
fonte: Golden Retriever — perfil da raça e cuidados de saúde
url: https://www.akc.org/dog-breeds/golden-retriever/
editora: American Kennel Club (AKC)
raca: Golden Retriever
especie: cachorro
---

Cachorro da raça Golden Retriever: porte grande, predisposto a obesidade e displasia coxofemoral. Nesta clínica o eixo de prevenção é Avaliação de peso e escore corporal a cada 6 meses; se já estiver acima do peso, inclua Hemograma antes de restringir dieta. Filhote de raça grande não entra em ração de emagrecimento antes do fechamento ósseo.

Cachorro da raça Golden Retriever com claudicação ou risco articular: mantenha peso ideal e exercício de baixo impacto. Se o catálogo permitir, Ultrassom abdominal entra na investigação; não invente radiografia OFA, PennHIP, fisioterapia ou cirurgia de quadril — esses itens não estão no menu.

Cachorro da raça Golden Retriever e rotina: além do que a WSAVA já cobre, a raça que nada ou frequenta creche se beneficia de Giárdia. Vacinas desta clínica são V10 e Antirrábica. Vermífugo e Exame de fezes seguem o intervalo do catálogo. Castração só se o animal ainda não for castrado.

Cachorro da raça Golden Retriever — o que não fazer: não copie conduta de Labrador ou de SRD só pelo porte. Não recomende vacina de leishmaniose nem painel genético se isso não estiver no CSV. O plano só pode usar os nomes exatos do catálogo.
```

Gato: prefixo `Gato da raça Persa`, `especie: gato`, itens V5 / Teste FIV/FeLV / Vacina FeLV quando couber. SRD: `raca: SRD` e prefixo `Cachorro da raça SRD` ou `Gato da raça SRD`.
