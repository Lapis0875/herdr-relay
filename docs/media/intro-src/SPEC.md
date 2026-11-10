# SPEC: herdr-relay intro (storyline A)

```text
GOAL:    the viewer knows herdr-relay puts their Mac's Herdr on an iPad and a phone, rearranged per screen, and that
         acting on a device leaves the Mac alone; they remember "my Herdr, on every screen".
OUTPUT:  HyperFrames 1920 x 1080, 30 fps; delivered as 1600 x 900 H.264 (docs/media/intro.mp4) and a 960 x 540 GIF.
TIME:    18.0 s x 30 = 540 frames. No music, no voice (made to play muted inline).
LOOK:    ground: radial #f5f6f8 (center, 46% down) -> #eaecef (58%) -> #dfe2e6 (edge), the README preview's sweep,
         no grain, no vignette. Ink #16181d; quiet ink #4a505c; faint #6a717d. Accent #2a6bcc (the product's guide
         blue #6aa8f0 darkened for a light ground), only on the name in line 2 and "every screen." on the end card.
         Display: Geist (the device app's own UI face, OFL, assets/fonts) 600, 56 px, -0.022em, one line at a time,
         left edge 192 px (title-safe), top 104 px. End mark Geist 640 at 132 px, -0.045em; tagline Geist 500 46 px;
         address Geist 500 28 px. Terminal: JetBrains Mono (the app's terminal face) 12 px at the kit's design size,
         scaled 2.35 -> 28 px.
         Medium: real product UI. Mac: the bridge's own render of Herdr's main layout at 1440 x 900 (device menu
         hidden), 14 px radius, the kit's 12 px traffic lights over its sidebar header. iPad: 1180 x 820 pt screen,
         18 px black-glass bezel, 38 px outer radius, its status bar with the kit's iOS glyphs. iPhone: the stageshow
         kit's Phone (pro, 402 x 874 pt). Terminal: the kit's terminal chrome.
         Depth: 0 40 80 -24 rgba(24,27,33,.42) + 0 16 32 -16 rgba(24,27,33,.28) on Mac and iPad; phone drop-shadow
         0 30 40 .30 + 0 10 16 .20. No glow, no grain.
OBJECTS: a Mac window (lights, sidebar, tabs, two terminal panes, status row); a terminal window; an iPad in landscape
         (bezel, status bar with 9:41 Tue Jan 9 and battery); an iPhone (island, status bar, home indicator); a finger
         (a 48 pt soft disc, rgba(240,242,248,.36), ring .24, only while touching).
MOTION:  arrive expo.out 0.9 s; travel and camera power2.inOut 0.7-0.8 s; exit power3.in 0.35-0.45 s; titles per
         word blur 6 -> 0 in 0.13 s, 0.067 s apart, or the whole line blur 8 -> 0 in 0.2 s, or grey -> ink per word
         0.085 s apart; title exits blur-out 0.18 s. Touch: in 0.15 s, press scale 0.82 in 0.1 s, drag 27 frames
         power2.inOut (the capture's own cubic), lift 0.12 s + fade 0.4 s. Render-time motion blur on.
SHOTS:   0-75     S1 Mac window pinned, 192 px gutters, 15% off the bottom; L1 "Your Herdr runs on your Mac" lands
                  0.25-0.6 s, holds to 2.38. Hands off: the Mac starts stepping back as the line leaves.
         75-185   S2 Mac to 0.75 at top-left (2.45-3.25); terminal rises from below (2.75-3.65); "herdr-relay start"
                  types 3.35-3.77; six real log lines 3.88-4.4; L2 "herdr-relay runs every mod sandboxed" 2.95-5.92.
         185-290  S3 terminal drops out (6.1-6.55); iPad arrives from the right (6.3-7.2), phone 0.15 s later; L3
                  "Same layout, rearranged for each screen" 6.75-9.18.
         290-375  S4a phone exits right (9.25-9.6); iPad comes forward over the Mac to 1.263 (9.45-10.15); L4
                  "Resize it on the iPad" 9.7-12.22. 312-363: the real drag clip (press 10.43, drag to 380 px,
                  release 11.5, re-layout); the finger rides the guide line.
         375-445  S4b iPad steps back (12.5-13.2), phone returns (12.7-13.55); the Mac, uncovered, is unchanged;
                  L5 "The Mac's layout never changes" 13.05-14.72.
         445-540  S5 the group settles under the name (14.8-15.6, 0.7 scale, off the bottom); "herdr-relay" wipes in
                  15.25-15.8, tagline 15.65, address 16.15; holds to 18.0.
BANNED:  dark void ground; glow, bloom, particles; purple or blue gradients, glass cards; cream paper + serif; mono
         caps labels and "01 / 02"; everything centred (only the end card is); everything fading and sliding up;
         text moving while read; HUD, corner labels, frame borders; three cards in a row; a title over a dimmed
         screenshot; a docked or invented logo (a letter in a square, the PWA icon as a mark); sparkles; translucent
         devices; a drawn notification or invented UI; a mockup of Herdr; personal paths, names or tailnet hosts;
         a slow creeping zoom after a landing.
QA:      t=0 the Mac window is the whole thumbnail; 1.8 L1 whole; 4.6 all six log lines whole inside the terminal;
         9.0 three devices, the phone straddling the iPad's chrome; 10.9 guide line, "px" readout and finger on one
         line; 12.0 widened sidebar with full agent rows; 13.9 the Mac identical to 9.0; 17.9 name, tagline,
         address, three screens, the iPad's sidebar still wide.
```
