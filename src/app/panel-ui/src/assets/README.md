# Model And Provider Marks

`providers/<brand>.svg` and `model-icons/<family>.svg` are product assets,
loaded locally by the settings, model picker and conversation UI.

## Selection

- Prefer the source's colour variant when it represents the same current mark.
- Preserve native fills and gradients in the canonical file. Do not replace
  them with `currentColor` or recolour them through CSS.
- Keep genuinely monochrome marks theme-aware with `currentColor`.
- Do not use an obsolete mark just because its source file ends in `-color`.
  StepFun's current monochrome mark differs from the older colour artwork.
- Appearance → Model and provider icons selects brand or theme-monochrome.
- `.mono.svg` variants are loaded alongside canonical originals; originals remain unchanged.
- Genuinely monochrome canonical marks are reused for both styles.
- Asset names are product identity keys. Azure OpenAI must resolve to
  `azure-openai`, not the broader `openai` match.

## Source

Colour variants restored on 2026-09-30 come from LobeHub's `lobe-icons`,
revision `329f378cbd1a88f45b60cd096b9111ce16f3ea39`, under
`packages/static-svg/icons`. Its MIT notice is in `LICENSE.lobe-icons.txt`.
The SVG geometry and brand colours are retained; filenames map it to existing
product keys. Kimi's neutral white letter follows `currentColor` so it remains
visible on both themes; its blue accent is unchanged.

| Product File | Upstream File |
| --- | --- |
| `providers/amazon-bedrock.svg` | `bedrock-color.svg` |
| `providers/fireworks.svg` | `fireworks-color.svg` |
| `providers/huggingface.svg` | `huggingface-color.svg` |
| `model-icons/aion.svg` | `aionlabs-color.svg` |
| `model-icons/arcee.svg` | `arcee-color.svg` |
| `model-icons/gemma.svg` | `gemma-color.svg` |
| `model-icons/kimi.svg` | `kimi-color.svg` |
| `model-icons/longcat.svg` | `longcat-color.svg` |

Groq keeps its existing geometry and uses `#F55036`, declared by LobeHub's
`src/Groq/style.ts` at the same revision. Xiaomi keeps its existing geometry
and retains white lettering over `#FF6900`, recorded for Xiaomi in Simple Icons'
`data/simple-icons.json` (source: Xiaomi's global site).

Source repositories:

- https://github.com/lobehub/lobe-icons
- https://github.com/simple-icons/simple-icons

Brand artwork remains subject to the respective owners' trademark policies.

## Theme-monochrome variants

Variants imported from the reviewed `synech-monochrome-icons` delivery use the same identity keys as existing product assets. New package-only identities are not installed. Package provenance is recorded in `monochrome-manifest.csv`; notices are under `licenses/monochrome/`.

Already monochrome originals (including GPT, Grok, StepFun, dots, kat, nex, and the generic provider mark) are reused; selecting brand style does not fabricate brand colours. Seed is a foreground-only conversion of the existing local wordmark, with geometry unchanged, because the package does not include it. The official-colour package is reviewed separately; it is not applied wholesale.
