# Gut Test Extension (v4.0)

Chrome-extensie om gut tests met klanten te draaien.

## Verloop van een test

1. **Intro-slide.** "Start Gut Test" (popup, Tests beheren of `Ctrl+Shift+C`) opent een eigen, gemaximaliseerd venster: zwarte achtergrond, witte tekst, uitleg over de gut test en een QR-code voor de telefoon. De test start pas als je op de knop drukt (of op Enter). Rechtsboven kies je **NL** of **EN**: alles wat de klant daarna ziet (de balken tijdens de test, de review-pagina, de ranking en de telefoonpagina) volgt die taal. De keuze wordt onthouden voor de volgende test. De popup en "Tests beheren" blijven Nederlands.
2. **Kijkronde.** Alle websites komen één keer voorbij in hetzelfde venster. Bovenaan in het midden staat de voortgang: "Website 3 van 10", één balkje per site, en het balkje van de huidige site loopt vol met de timer. Onderin het midden staat een bedieningsbalk: vorige/volgende, screenshot, QR-code voor de telefoon, muziek aan/uit, pauzeren en +10s. Cijfers geven kan tijdens de kijkronde niet; dat gebeurt pas daarna. Van elke site wordt automatisch een hero-screenshot gemaakt.
3. **Beoordelen op één pagina.** Na de laatste site gaan de site-tabs dicht en opent de review-pagina: per website een kleine, echte versie waar je doorheen kunt scrollen, met daarnaast het cijfer (1–10), notities en de notities van de telefoon. Toets 1–9 en 0 (= 10) geven de site in beeld een cijfer. Met "Afronden" stopt de muziek en zie je het dashboard.

"Alleen beoordelen" in de popup opent de review-pagina direct, zonder kijkronde.

## Notities via de telefoon

De klant scant de QR-code (op de intro-slide, onderin tijdens de test via 📱 Telefoon, of rechtsboven op de review-pagina). Wat er op de telefoon wordt getypt, komt binnen enkele seconden in het veld **Telefoon-notities** van de website die op dat moment in beeld is. Op de telefoonpagina kun je ook zelf een site kiezen.

De koppeling loopt via [ntfy.sh](https://ntfy.sh), een gratis openbare berichtendienst zonder account. Elke test krijgt een eigen kanaal met een lange willekeurige naam; alleen wie de QR-code heeft, kan meelezen. ntfy.sh bewaart berichten maximaal 12 uur.

Er zijn twee opties voor wat de QR-code opent:

- **Zonder instelling (werkt direct):** de ntfy-webapp voor dat kanaal. De klant typt onderaan een bericht en het komt bij de site in beeld. Begint een bericht met `#3 `, dan komt het bij site 3.
- **Met eigen telefoonpagina (mooier):** host `phone/index.html` ergens statisch, bijvoorbeeld op GitHub Pages, Netlify (sleep de map `phone` naar app.netlify.com/drop) of de eigen webserver. Vul de URL in de popup in bij *Instellingen → Telefoon-pagina*. De klant ziet dan welke website in beeld is en kan per site notities sturen.

## Muziek

Standaard speelt er een zelf gegenereerde chillhop-beat: drums, bas, Rhodes-akkoorden en een melodie die per ronde varieert. Er is geen audiobestand nodig en dus geen licentie. Volume en aan/uit staan in de popup-instellingen, en tijdens de test via 🎵.

Wil je een eigen nummer? Zet een mp3 op `music/achtergrond.mp3`. Die wordt dan in een lus afgespeeld in plaats van de beat. Gebruik rechtenvrije muziek, bijvoorbeeld van de Pixabay Music- of YouTube Audio Library.

## Installeren / bijwerken

`chrome://extensions` → Ontwikkelaarsmodus aan → "Uitgepakte extensie laden" → deze map. Na een update op ↻ bij de extensie klikken.

## Bekende beperkingen

- Een paar websites weigeren in een kleiner venster te laden of breken bewust uit. Klik op de review-pagina dan op **Screenshot** (de automatische hero-screenshot) of **Open ↗**.
- De telefoonkoppeling heeft internet nodig op de laptop en op de telefoon.
