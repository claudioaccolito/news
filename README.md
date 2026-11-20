# Edicola

Un lettore di notizie **solo testo**, installabile come PWA, senza account e senza tracciamento.

**Apri:** https://claudioaccolito.github.io/news/

- Al primo avvio scegli gli argomenti: Edicola propone le fonti giuste tra quasi 200 testate italiane e internazionali in 17 categorie.
- Notizie dalla più recente, con fonte e data; filtri per categoria e fonte, ricerca istantanea.
- Tocca una notizia per leggerla: titolo, autore, data e testo (quando la fonte lo pubblica nel feed), con il pulsante per aprire l'originale.
- Aggiungi qualsiasi feed RSS o Atom (blog, ricerche su Hacker News…).
- Facoltativo: un modello AI, **locale** (Ollama, LM Studio, llama.cpp) o via API (OpenAI, Anthropic, OpenRouter, qualsiasi endpoint compatibile OpenAI), per il riassunto del giorno e un TL;DR in italiano di ogni articolo.
- Tema chiaro/scuro, dimensione del testo, esporta/importa le impostazioni.

## Privacy, costi e manutenzione

I browser non possono leggere quasi nessun feed RSS direttamente (CORS), quindi:

1. Ogni 30 minuti una **GitHub Action** (`.github/workflows/news.yml`) legge *tutte* le fonti del catalogo e pubblica su GitHub Pages un unico pacchetto (`data/news.json`, più il testo lungo in `data/content/0-f.json`, suddiviso per hash).
2. Ogni dispositivo scarica **lo stesso pacchetto intero** e filtra in locale. Né GitHub né le testate sanno quali fonti segui; aprendo un articolo si scarica un frammento scelto per hash, che non rivela la fonte.
3. Le preferenze stanno in `localStorage`. Non ci sono database: il pacchetto contiene solo gli ultimi 3 giorni e il service worker ne tiene una sola copia per l'uso offline. Le cache locali (letti, TL;DR, riassunti) si ripuliscono da sole dopo 4 giorni.
4. I feed aggiunti a mano vengono letti direttamente dal browser. Il proxy CORS è facoltativo e spento per impostazione predefinita.

Le GitHub Actions sono gratuite per i repository pubblici. Il workflow si riattiva da solo tramite API, così GitHub non lo sospende dopo 60 giorni di inattività.

## Configurazione (una volta sola)

Settings → Pages → Source: **GitHub Actions**.

## Modello AI locale

```sh
OLLAMA_ORIGINS="https://claudioaccolito.github.io" ollama serve
ollama pull llama3.2
```

Poi in Edicola: Impostazioni → Intelligenza artificiale → Ollama.

## Struttura

| File | Cosa fa |
| --- | --- |
| `data/catalog.json` | Catalogo di categorie e fonti (per aggiungere una fonte basta una riga) |
| `scripts/build-news.mjs` | Scarica i feed e genera il pacchetto (Node, zero dipendenze) |
| `js/feed-parser.js` | Parser RSS/Atom condiviso tra Action e browser |
| `js/app.js`, `js/store.js`, `js/ai.js` | L'app (JavaScript puro, nessun build) |
| `sw.js`, `manifest.webmanifest` | PWA e uso offline |

Prova in locale: `node scripts/build-news.mjs _site/data`, poi servi la cartella con `data/` da `_site`.
