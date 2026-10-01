# Guitar Tuner

A web-based instrument tuner. It listens through your microphone, works out the pitch and tells you which way to turn the peg.

No build step, no dependencies. Just static files.

## Features

- **Auto mode**: detects which string you're playing and tunes against it
- **Lock string**: tap a string to tune only that one (tap it again to go back to auto)
- **Chromatic mode**: shows the nearest note for anything you play
- **Tons of tunings**: standard, half/full step down, C/B standard, Drop D/C#/C/B/A#/A, double drop D,
  open D/Dm/E/G/Gm/A/C/C6/F/B, DADGAD, DADDAD, CGCGCD, all fourths, major thirds, Fripp's new standard, Nashville
- **Other instruments**: 7 and 8-string guitar, 4/5/6-string bass, ukulele (high G, low G, D, baritone), 5-string banjo, mandolin
- **Custom tunings**: pick any note per string, saved in your browser
- **Reference tones**: turn on "Play note on tap" to hear a plucked reference for each string
- **A4 calibration**: 400 to 480 Hz (432 crowd, you're covered)
- Ticks off each string once it holds in tune, keeps your screen awake while tuning

Pitch detection uses the YIN algorithm with a median filter, accurate to well under 1 cent on clean signals down to a low B on a 5-string bass.

## Running it

The microphone only works on **HTTPS or localhost** (browser rule, not mine).

Locally:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

To use it on your phone, host it anywhere that serves static files over HTTPS: GitHub Pages, Netlify, Vercel, Cloudflare Pages.

## Files

- `index.html` – layout
- `style.css` – styles
- `tunings.js` – all the instrument/tuning presets (add your own here)
- `tuner.js` – audio, pitch detection and UI logic
