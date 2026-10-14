# Gut Test Extension (v4.0)

Chrome extension for running gut tests with clients.

## How a test works

1. **Intro slide.** "Start Gut Test" (popup, *Tests beheren* or `Ctrl+Shift+C`) opens a separate, maximized window: black background, white text, an explanation of the gut test and a QR code for the phone. The test only starts when you press the button (or Enter). In the top right you choose **NL** or **EN**: everything the client sees afterwards (the bars during the test, the review page, the ranking and the phone page) follows that language. The choice is remembered for the next test. The popup and *Tests beheren* (manage tests) stay in Dutch.
2. **Viewing round.** Every website is shown once in the same window. At the top center you see the progress: "Website 3 of 10", one bar per site, and the current site's bar fills up with the timer. At the bottom center there is a control bar: previous/next, screenshot, phone QR code, music on/off, pause and +10s. Scoring isn't possible during the viewing round; that happens afterwards. A hero screenshot of every site is taken automatically.
3. **Rating on one page.** After the last site the site tabs close and the review page opens: for each website a small but real version you can scroll through, next to it the score (1–10), notes and the notes from the phone. Keys 1–9 and 0 (= 10) score the site on screen. "Finish" stops the music and shows the dashboard.

*Alleen beoordelen* (review only) in the popup opens the review page directly, without a viewing round.

## Notes from the phone

The client scans the QR code (on the intro slide, at the bottom during the test via 📱 Phone, or in the top right of the review page). Whatever is typed on the phone appears within a few seconds in the **Phone notes** field of the website on screen at that moment. On the phone page the client can also pick a site themselves.

The connection runs via [ntfy.sh](https://ntfy.sh), a free public messaging service without an account. Every test gets its own channel with a long random name; only someone with the QR code can read along. ntfy.sh keeps messages for at most 12 hours.

There are two options for what the QR code opens:

- **Without setup (works right away):** the ntfy web app for that channel. The client types a message at the bottom and it lands on the site on screen. If a message starts with `#3 `, it goes to site 3.
- **With your own phone page (nicer):** host `phone/index.html` anywhere static, for example on GitHub Pages, Netlify (drag the `phone` folder to app.netlify.com/drop) or your own web server. Enter the URL in the popup under *Instellingen → Telefoon-pagina* (settings → phone page). The client then sees which website is on screen and can send notes per site.

## Music

By default a self-generated chillhop beat plays: drums, bass, Rhodes chords and a melody that varies each round. No audio file is needed, so no license either. Volume and on/off are in the popup settings, and during the test via 🎵.

Want your own track? Put an mp3 at `music/achtergrond.mp3`. It then loops instead of the beat. Use royalty-free music, for example from Pixabay Music or the YouTube Audio Library.

## Install / update

`chrome://extensions` → turn on Developer mode → "Load unpacked" → this folder. After an update, click ↻ on the extension.

## Known limitations

- A few websites refuse to load in a smaller window or deliberately break out. On the review page, click **Screenshot** (the automatic hero screenshot) or **Open ↗** instead.
- The phone connection needs internet on both the laptop and the phone.
