# Integratiekeuzes en controlegrenzen

Gecontroleerd op 8 september 2026.

De gekozen aansluiting is de officieel gedocumenteerde Secure MCP Tunnel met een lokale stdio MCP-server. De software logt niet in op ChatGPT, leest geen cookies of tokens van de browser, gebruikt geen private ChatGPT-endpoints en automatiseert de ChatGPT-interface niet. MCP-resultaten worden via het daarvoor bedoelde protocol aangeleverd.

Uit de actieve distributie verwijderd: browserextensie, browser bridge, chatrecorder, automatische prompts, automatische voortzetting, goals, loops, agents, compaction, tabherstel, updater en de bijbehorende Electron-app en workflows.

De lokale bestandstools vragen om expliciet ingestelde mappen. Externe MCP-servers hebben een expliciete toollijst; ontbrekende tools stoppen de startup. De server geeft geen tools door waarmee de remote client zijn configuratie, roots of allowlist kan aanpassen. Een externe tool kan op zichzelf echter brede bevoegdheden hebben. Beoordeel zowel zijn implementatie als zijn voorwaarden. MCP-annotations afdwingen geen lokale bevestiging; ChatGPT beheert zijn eigen goedkeuringsscherm.

De fork levert geen onbeperkte claim dat alle mogelijke toepassingen aan alle voorwaarden voldoen. Ook bevoegd gebruik, rechten op gegevens, privacy en de voorwaarden van aangesloten diensten blijven relevant. OpenAI heeft deze fork niet beoordeeld of gecertificeerd. Er is geen live acceptatietest in het ChatGPT-account uitgevoerd.

Officiële bronnen:

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [MCP verbinden en testen in ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [ChatGPT developer mode](https://developers.openai.com/api/docs/guides/developer-mode)
- [Europe Terms of Use](https://openai.com/policies/eu-terms-of-use/)
