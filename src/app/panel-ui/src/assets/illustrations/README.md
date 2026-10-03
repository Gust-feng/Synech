# Product Scenes

## Space Kite

`space-kite.svg` is the static default artwork for the Space reader when no
note or material is being previewed. It is decorative, transparent, and uses
a 640 by 430 viewBox.

The original figure was created as an AI-assisted graphite and colored-pencil
study for Synech. Its approved pose was converted to native vector paths with
VTracer 0.6.15 and composed with the authored kite and shoreline. The selected
figure trace contains 1,049 paths. The final artwork retains the approved
adjustment: figure enlarged by 12%, kite scaled to 72%, and grasses to 55%.

The SVG contains no embedded bitmap, scripts, or external resources. Keep it
as a standalone image resource rather than inserting its paths into the React
component tree. Its palette belongs to the artwork and is not recolored with
the current Space accent.

The asset is required product source. The experimental conversion tools,
source studies, and design history are local development material and are not
runtime or build dependencies. Rendering the scene does not require Python,
VTracer, an image service, or a network request to an external provider.
