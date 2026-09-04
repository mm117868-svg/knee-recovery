# Knee Recovery (test build)

Static copy of the browser version of Knee Recovery (Cambridge Kinematics).
`index.html` is the patient app, `bench.html` the bench page with every
control exposed, `report.html` the physio report built from the records the
browser holds. `kneerec.js` holds the two layers: MediaPipe Pose for a
whole-session knee angle, a pixel-motion counter for repetitions, written
side by side and never joined. Everything runs in the visitor's browser; no
video leaves the device. Passcode gate on entry; noindex.

Serve with GitHub Pages (Settings > Pages > Deploy from branch, root).
Built by `tools/pages.py` in the knee-recovery folder; edit there, not here.
