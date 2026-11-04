# Resultados do plano de cuidados

Medido em 2026-11-04T22:37:06.969Z contra `http://localhost:3000`. Cada linha é uma resposta real de `POST /v1/care-plan`. Itens conferidos com `api/data/clinica-catalogo.csv`. Tempos em milissegundos, lidos do header `Server-Timing`.

| Caso | Pet | Itens | Fontes | cache | embed | vector | catalog | llm | post | total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Labrador | Thor, Labrador, 3 anos, 28,5 kg, não castrado | Avaliação de peso e escore corporal, Exame de fezes, Hemograma, Castração, Vermífugo, Antirrábica, Giárdia, V10 | Labrador Retriever — perfil da raça e cuidados de saúde, Diretrizes de estágio de vida canina (AAHA, 2019) — cães sem raça definida | 318 | 532 | 189 | 195 | 868 | 1214 | 3122 |
| Persa | Luna, Persa, 2 anos, 4 kg, castrada | Avaliação de peso e escore corporal, Exame de fezes, Hemograma, Teste FIV/FeLV, Antirrábica, V5 | Doença renal policística felina (PKD) — Cornell Feline Health Center, Escolha e cuidados com o gato — Cornell Feline Health Center (incluindo mestiços) | 220 | 0 | 0 | 0 | 0 | 0 | 220 |
| Cão SRD | Mel, SRD, 4 anos, 12 kg, castrada | Avaliação de peso e escore corporal, Exame de fezes, Hemograma, Vermífugo, Antirrábica, V10 | Diretrizes de estágio de vida canina (AAHA, 2019) — cães sem raça definida, Escolha e cuidados com o gato — Cornell Feline Health Center (incluindo mestiços) | 148 | 372 | 164 | 156 | 861 | 890 | 2434 |
| Gato SRD | Mingau, SRD, 3 anos, 4,5 kg, não castrado | Avaliação de peso e escore corporal, Exame de fezes, Hemograma, Teste FIV/FeLV, Castração, Vermífugo, Antirrábica, V5 | Escolha e cuidados com o gato — Cornell Feline Health Center (incluindo mestiços), Diretrizes de estágio de vida canina (AAHA, 2019) — cães sem raça definida, Doença renal policística felina (PKD) — Cornell Feline Health Center | 997 | 0 | 0 | 0 | 0 | 0 | 997 |
| Dermatite | Thor, Labrador, diagnóstico de dermatite atópica | Raspado de pele, Tratamento de dermatite, Avaliação de peso e escore corporal, Vermífugo, V10, Antirrábica, Castração | Dermatite atópica canina — ICADA / Merck Veterinary Manual, Labrador Retriever — perfil da raça e cuidados de saúde, Diretrizes de estágio de vida canina (AAHA, 2019) — cães sem raça definida | 0 | 341 | 166 | 158 | 807 | 1001 | 2316 |
| Comportamento | Thor, Labrador, relato de coceira nas patas | Raspado de pele, Tratamento de dermatite, V10, Antirrábica, Giárdia, Avaliação de peso e escore corporal, Exame de fezes, Vermífugo | Dermatite atópica canina — ICADA / Merck Veterinary Manual, Labrador Retriever — perfil da raça e cuidados de saúde, Diretrizes de estágio de vida canina (AAHA, 2019) — cães sem raça definida | 0 | 359 | 163 | 163 | 1067 | 986 | 2575 |
| Vacina e medicamento | Thor, Labrador, V10 em 2026-08-01 e prednisolona desde 2026-09-01 | Avaliação de peso e escore corporal, Exame de fezes, Hemograma, Castração, Vermífugo, Giárdia | Labrador Retriever — perfil da raça e cuidados de saúde, Diretrizes de estágio de vida canina (AAHA, 2019) — cães sem raça definida, Vacinação antirrábica canina e felina — Instituto Pasteur / Secretaria da Saúde de São Paulo | 0 | 357 | 236 | 158 | 940 | 1177 | 2711 |

## Descrições

### Labrador

Para o Thor, o plano de cuidados prioriza a Avaliação de peso e escore corporal e o Hemograma para o controle do apetite e peso do Labrador. A prevenção de parasitas e doenças é garantida com Exame de fezes, Vermífugo, V10, Antirrábica, Giárdia e a realização da Castração.

### Persa

Luna é uma gata persa de 2 anos, 4 kg e castrada. O plano prioriza Avaliação de peso e escore corporal a cada 6 meses, Exame de fezes a cada 6 meses, Hemograma 1×/ano, Teste FIV/FeLV, Antirrábica 1×/ano, V5 1×/ano.

### Cão SRD

O plano de cuidados para a Mel prioriza a prevenção e a manutenção da saúde através de Avaliação de peso e escore corporal, Exame de fezes, Hemograma, Vermífugo, Antirrábica e V10, garantindo o acompanhamento adequado para sua fase de vida.

### Gato SRD

Mingau é um gato srd de 3 anos, 4.5 kg e não castrado. O plano prioriza Avaliação de peso e escore corporal a cada 6 meses, Exame de fezes a cada 6 meses, Hemograma 1×/ano, Teste FIV/FeLV, Castração, Vermífugo a cada 3 meses, Antirrábica 1×/ano, V5 1×/ano.

### Dermatite

Para cuidar do prurido e da dermatite atópica do Thor, o plano inclui Raspado de pele e Tratamento de dermatite. A prevenção conta com Avaliação de peso e escore corporal, Vermífugo, V10, Antirrábica e Castração.

### Comportamento

Para cuidar do Thor e investigar a coceira e prurido nas patas, o plano conta com o Raspado de pele e o Tratamento de dermatite. Também inclui a prevenção com V10, Antirrábica, Giárdia, Vermífugo, Exame de fezes e a Avaliação de peso e escore corporal.

### Vacina e medicamento

Thor é um cão labrador de 3 anos, 28.5 kg e não castrado. O plano prioriza Avaliação de peso e escore corporal a cada 6 meses, Exame de fezes a cada 6 meses, Hemograma 1×/ano, Castração, Vermífugo a cada 3 meses, Giárdia 1×/ano.

Para repetir: `node scripts/report-results.mjs`.
