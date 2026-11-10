# REVIEW: herdr-relay intro

Built storyline A ("one frame that rebuilds", STORYLINES.md). Not built: B "Away from the desk" (a Finished push on
the phone's lock screen) and C "The layout comes apart" (an exploded view of the layout's nodes).

## Creative calls

- Every product screen is a real render of the snapshot bridge against a synthetic fake core (scratch HOME, no real
  terminals): the Mac window is the bridge's desktop-size render of Herdr's `main` layout (device menu hidden, macOS
  lights added), not a capture of the Herdr app itself; the iPad and phone are the device app at 1180 x 820 and
  402 x 874. The drag is 51 real frames of the sidebar separator being dragged 268 -> 380 px.
- The phone frame, terminal chrome and window lights are the stageshow kit's own markup and CSS (rendered with
  react-dom/server; `--ss-mono` pointed at JetBrains Mono). The iPad frame is hand-built (the kit has no tablet),
  matching the README preview's bezel.
- Silent on purpose: the README shows it as an autoplaying muted GIF; the mp4 is the same cut.

## Measured

- `hyperframes check`: ok, 0 errors. Warnings kept: `css_transition_used` x3 and `negative_z_index` come from the
  kit CSS copy (inert: no state changes, and the scene forces `transition: none`); `nested_media_start_basis_ambiguous`
  (the clip's 10.4 s is composition-local, as intended); `film_silent` (above); `line_unread` on the six terminal log
  lines (2.6 s on screen; they are evidence texture, the line to read is L2, held 3 s).
- `snapshot --review` beat and 360 px phone sheets, `--range` strips around every move, and decoded frames of the
  rendered file at 0, 1.8, 4.6, 9.0, 10.9, 12.0, 13.9, 17.9 s. ffprobe: 18.000 s, 540 frames, 30 fps.

## Looked at only

The finger's sync with the guide line (checked on stills at 10.6 and 10.9 s, not frame by frame), the GIF's palette.

## Weakest shot

S3 (6-9 s): the iPad, the hero of the next beat, is the most covered device (the phone sits on its top-right corner
and it runs off the bottom). With more time: give the iPad more of the frame there, and adopt the registry's
`touch-indicator` (found after the finger was hand-built to the kit's touch spec).
