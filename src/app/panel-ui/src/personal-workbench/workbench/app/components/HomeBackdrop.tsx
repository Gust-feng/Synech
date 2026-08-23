const HOME_SCENE_WIDTH = 1440
const HOME_SCENE_HEIGHT = 900

export function HomeBackdrop() {
  return (
    <div className="aa-agent-home__backdrop" aria-hidden="true">
      <svg
        viewBox={`0 0 ${HOME_SCENE_WIDTH} ${HOME_SCENE_HEIGHT}`}
        preserveAspectRatio="xMidYMax slice"
        width="100%"
        height="100%"
        focusable="false"
      >
        <defs>
          <linearGradient id="aa-home-light-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#efeaf6" />
            <stop offset="0.34" stopColor="#f1edf4" />
            <stop offset="0.64" stopColor="#f4f1ee" />
            <stop offset="1" stopColor="#f4f2ef" />
          </linearGradient>
          <radialGradient id="aa-home-light-sun" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#faf0e2" />
            <stop offset="0.42" stopColor="#f7ecdd" stopOpacity="0.9" />
            <stop offset="1" stopColor="#f7ecdd" stopOpacity="0" />
          </radialGradient>

          <linearGradient id="aa-home-night-paper" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#22242c" />
            <stop offset="0.46" stopColor="#1f2128" />
            <stop offset="1" stopColor="#1b1b20" />
          </linearGradient>
          <linearGradient id="aa-home-night-sheet-a" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#45475a" />
            <stop offset="1" stopColor="#3a3c4d" />
          </linearGradient>
          <linearGradient id="aa-home-night-sheet-b" x1="0" y1="0" x2="0.9" y2="1">
            <stop offset="0" stopColor="#30353e" />
            <stop offset="1" stopColor="#2a2f36" />
          </linearGradient>
        </defs>

        <g className="aa-agent-home__scene aa-agent-home__scene--light">
          <rect width={HOME_SCENE_WIDTH} height={HOME_SCENE_HEIGHT} fill="url(#aa-home-light-sky)" />
          <circle cx="1090" cy="250" r="240" fill="url(#aa-home-light-sun)" />
          <circle cx="1090" cy="250" r="52" fill="#f8efdb" />
          <rect x="0" y="392" width={HOME_SCENE_WIDTH} height="120" fill="rgba(104,101,167,0.04)" />

          <g
            fill="none"
            stroke="rgba(110,103,132,0.45)"
            strokeLinecap="round"
            strokeWidth="2.4"
          >
            <path d="M732 84 q15 -13 30 0 q15 -13 30 0" />
            <path d="M806 116 q11 -9 22 0 q11 -9 22 0" />
            <path d="M696 138 q8 -7 16 0 q8 -7 16 0" />
          </g>

          <path
            d="M0 486 C240 430 420 448 620 424 C840 398 1060 424 1240 408 C1340 399 1410 410 1440 404 L1440 900 L0 900 Z"
            fill="rgba(104,101,167,0.08)"
          />
          <path
            d="M0 566 C220 512 400 528 600 506 C820 482 1020 512 1220 496 C1330 487 1400 506 1440 498 L1440 900 L0 900 Z"
            fill="rgba(122,150,124,0.12)"
          />
          <path
            d="M0 650 C200 602 380 626 580 612 C800 597 1020 628 1220 616 C1330 609 1400 628 1440 620 L1440 900 L0 900 Z"
            fill="rgba(96,116,100,0.16)"
          />
        </g>

        <g className="aa-agent-home__scene aa-agent-home__scene--dark">
          <rect width={HOME_SCENE_WIDTH} height={HOME_SCENE_HEIGHT} fill="url(#aa-home-night-paper)" />

          <path
            d="M0 382 C254 357 486 374 720 388 C962 403 1194 382 1440 397 L1440 468 C1174 455 968 470 722 455 C478 440 248 446 0 464 Z"
            fill="#918ba0"
            fillOpacity="0.018"
          />

          {/* Soft environmental layers begin immediately below the task entry, as in the light scene. */}
          <path
            d="M0 430 C228 392 420 418 620 402 C850 383 1060 420 1260 406 C1360 399 1420 408 1440 404 L1440 900 L0 900 Z"
            fill="url(#aa-home-night-sheet-a)"
            fillOpacity="0.66"
          />
          <path
            d="M0 560 C220 520 408 548 606 532 C830 514 1040 550 1240 538 C1350 531 1412 547 1440 542 L1440 900 L0 900 Z"
            fill="url(#aa-home-night-sheet-b)"
            fillOpacity="0.72"
          />
          <path
            d="M0 700 C210 666 392 692 588 682 C806 670 1020 700 1218 688 C1332 681 1402 698 1440 692 L1440 900 L0 900 Z"
            fill="#292c33"
            fillOpacity="0.68"
          />
        </g>
      </svg>
    </div>
  )
}
