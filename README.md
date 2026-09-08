# Chat On Steroids — MCP Only

Een afgeslankte, zelfstandige fork voor lokale bestanden en zelf gekozen MCP-tools in ChatGPT Web, via de officiële **Secure MCP Tunnel**. Geen browserextensie nodig.

**Status:** werkende lokale MCP-server met protocol- en bestandstests. De verbinding met jouw ChatGPT-account moet nog worden ingesteld en getest. Dit is een Node-app, geen Electron-app of macOS-installer.

## Wat zit erin?

- Gekozen mappen tonen en doorbladeren; UTF-8 tekstbestanden lezen tot 1 MiB.
- Bestaande tekstbestanden bewerken wanneer de map lokaal als schrijfbaar is ingesteld. Een SHA-256 controle voorkomt dat een eerder gewijzigde versie stilzwijgend wordt overschreven.
- Bestaande **stdio MCP-servers** starten en alleen expliciet geselecteerde tools doorgeven, met een eigen naam per server.
- De officiële stdio MCP-transportlaag voor OpenAI Secure MCP Tunnel.

Standaard zijn **geen mappen of externe servers gedeeld**. De configuratie wordt bij opstarten gelezen. Stop en herstart de verbinding na een wijziging en vernieuw de tools in ChatGPT.

## Wat is verwijderd?

De actieve branch bevat geen Electron-workspace, Chrome-extensie, DOM/React-uitlezing, chatopnames, promptinjectie in de ChatGPT-pagina, automatisch verzenden, goals/loops, agents, geplande taken, automatische voortzetting, compaction, tabherstel of oorspronkelijke release/updater. De oorspronkelijke code blijft als herkomst in Git-geschiedenis staan.

Er is geen ingebouwde shell, schermbediening of clipboardtool. Een expliciet toegelaten externe MCP-tool kan wel eigen laptopfuncties aanbieden. Zo'n server draait met jouw gebruikersrechten: de mapgrenzen hieronder beperken **alleen de ingebouwde bestandstools**.

## Installeren

Node.js 22 of hoger:

```sh
npm ci
cp config.example.json config.json
```

Bewerk `config.json`, bijvoorbeeld:

```json
{
  "roots": [
    { "name": "project", "path": "/absolute/path/to/project", "writable": true }
  ],
  "servers": [
    {
      "name": "mytools",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/your-mcp-server.js"],
      "allowTools": ["your_exact_tool_name"],
      "env": {}
    }
  ]
}
```

Vervang de voorbeeldpaden en toolnaam; laat `servers` leeg als je alleen bestanden wilt. Gebruik `writable: false` om een map alleen te lezen. `cwd` is optioneel voor een externe server. Gebruik een reeds geïnstalleerde en vertrouwde server; deze app installeert zelf geen plugins. HTTP/SSE-upstreams en interactieve OAuth worden in deze versie niet ondersteund.

`config.json` en `.env` zijn uitgesloten van Git. Bewaar eventuele secrets alleen lokaal en beperk de bestandsrechten (`chmod 600 config.json`). De tunnel-API-sleutel wordt niet automatisch doorgegeven aan externe MCP-processen. Expliciete waarden in `env` worden wel doorgegeven.

```sh
npm run check
npm run verify
```

`check` valideert de configuratie zonder MCP-processen te starten. `npm start` start de stdio-server; die verwacht een MCP-client en toont geen venster.

## Verbinden met ChatGPT Web

Gebruik de actuele [OpenAI Secure MCP Tunnel-handleiding](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). Je hebt tunneltoegang, een tunnel-ID, een runtime API-sleutel en developer-mode toegang in de juiste ChatGPT-workspace nodig. De API-sleutel dient hier voor de tunnel; deze app doet geen model-API-aanroepen.

Download de officiële `tunnel-client` via Platform tunnelinstellingen of [OpenAI's releases](https://github.com/openai/tunnel-client/releases/latest). Maak een lokaal stdio-profiel met het absolute Node-pad, het absolute pad naar `src/server.js` en `--config` met het absolute configuratiepad. Quote elk pad dat spaties bevat binnen de command-string. De precieze opties staan in `tunnel-client help quickstart`.

Voor paden zonder spaties:

```sh
# Zet CONTROL_PLANE_API_KEY veilig in je lokale omgeving; commit de sleutel niet.
tunnel-client init --sample sample_mcp_stdio_local --profile mcp-only \
  --tunnel-id YOUR_TUNNEL_ID \
  --mcp-command '/absolute/path/to/node /absolute/path/to/src/server.js --config /absolute/path/to/config.json'
tunnel-client doctor --profile mcp-only --explain
tunnel-client run --profile mcp-only
```

Activeer developer mode, voeg in ChatGPT een MCP-verbinding toe en kies **Tunnel**. Koppel de juiste tunnel, controleer de gevonden tools en voeg de verbinding toe aan een nieuwe chat. Zie de [officiële aansluitinstructies](https://developers.openai.com/plugins/deploy/connect-chatgpt) voor de actuele schermen. Toegang kan verschillen per account en workspace.

Probeer: “Toon mijn gedeelde mappen”, daarna “Lees a.txt uit project”. Controleer een bewerking op een testbestand en controleer de bevestiging die ChatGPT toont. De lokale tests bewijzen niet dat jouw account de verbinding kan gebruiken. Houd `tunnel-client` open tijdens gebruik; deze fork maakt geen opstarttaak of achtergrondplanning aan.

## Grenzen en voorwaarden

Deze implementatie volgt de officieel gedocumenteerde MCP-route. Dat is **geen juridische garantie, OpenAI-goedkeuring of certificering**. Het oorspronkelijke browsergedrag wordt niet gebruikt. Je gebruik en de externe tools moeten ook aan de toepasselijke voorwaarden voldoen. Zie [docs/COMPLIANCE.md](docs/COMPLIANCE.md).

Symlinks, bestanden met meerdere hardlinks, binaire bestanden, nieuwe bestanden en bestanden groter dan 1 MiB worden door de ingebouwde lees-/schrijftools geweigerd. De app is geen OS-sandbox tegen een kwaadwillend lokaal proces dat tegelijk mappen of bestanden vervangt. Bewerkingen zijn geen transacties: een crash of schijffout tijdens schrijven kan een gedeeltelijke wijziging achterlaten. Gebruik versiebeheer of een backup voor belangrijke bestanden.

MCP-resultaten gaan naar ChatGPT/OpenAI via de gekozen verbinding. Er worden geen chats uit de browser gehaald of lokaal opgeslagen. Een externe server kan een eigen opslag-, logging- en privacybeleid hebben. Alleen tools staan open; upstream resources, prompts, sampling en elicitations worden niet doorgestuurd. Externe tools krijgen conservatieve bevestigingsmetadata; die metadata is geen lokale autorisatiebarrière.

## Herkomst en ontwikkeling

Fork van [totec448-spec/chat-on-steroids](https://github.com/totec448-spec/chat-on-steroids), gebaseerd op commit `067c40dc64f3f108496aa9adf289f1e8c264fe9c`. MIT-licentie en oorspronkelijke copyrightvermelding behouden. De actieve implementatie is vervangen om alleen de gevraagde MCP-functies te leveren.

`npm run verify` voert lokale bestandstests, beveiligingsgrenzen, een echte stdio-upstream en een echte stdio-aanroep naar de entrypoint uit. Er is geen bundelstap; Node voert de geteste bronbestanden rechtstreeks uit.
