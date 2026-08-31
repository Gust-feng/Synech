/**
 * 安装完成 · 彩带粒子（Completion Confetti）
 * ==========================================
 * 原始设计还原（供参考，不依赖当前安装器代码）。
 *
 * 三个核心决策：
 * 1. 纯 DOM + WAAPI（Web Animations API），不用 canvas / 不用 CSS 关键帧。
 *    每个粒子是一个真实 <span>，运动轨迹由数学曲线采样成 keyframes 交给
 *    element.animate() 播放。原因见 README.md「为什么不用 canvas」。
 * 2. 粒子轨迹 = 抛物体（水平匀速 + 竖直匀加速），不是贝塞尔缓动。
 *    礼花是真实物理运动，用 easing 曲线模拟出来的抛物线总是"假"的——
 *    初速度、顶点、落地点都对不上。直接把物理公式按时间采样，所见即物理。
 * 3. 两波爆发错峰：主爆发 74 粒铺开，补爆 26 粒延迟 ~240ms 跟进，
 *    制造"先炸开、再补一波"的层次感，而不是一锅同时飞。
 */

export type CompletionConfettiHandle = {
  /** 立即取消所有粒子动画并移除彩带层（离场 / 重试 / reduced-motion 兜底用） */
  readonly cancel: () => void;
};

/** 品牌紫为主，少量暖色点缀——彩带要"属于这个品牌"，不是通用彩虹色 */
const PALETTE: readonly string[] = [
  "#716ab0", // 主品牌紫
  "#8f83c4",
  "#a79cd8",
  "#c7c0ec",
  "#5d5499",
  "#f2e5c8", // 暖白点缀
  "#d9b36a", // 金点缀
];

type BurstSpec = {
  /** 粒子数量 */
  readonly count: number;
  /** 该波的起始延迟（相对触发时刻） */
  readonly delayMin: number;
  /** 延迟抖动范围，避免所有粒子同一帧起飞显得机械 */
  readonly delaySpread: number;
  /** 初速度区间（px/s） */
  readonly speedMin: number;
  readonly speedSpread: number;
  /** 重力加速度（px/s²）——决定粒子的下坠弧线 */
  readonly gravity: number;
  /** 单粒子动画时长区间（ms） */
  readonly durationMin: number;
  readonly durationSpread: number;
};

const BURSTS: readonly BurstSpec[] = [
  // 第一波：主爆发。初速度区间宽（190–450 px/s），粒子散布自然拉开远近层次
  { count: 74, delayMin: 0, delaySpread: 90, speedMin: 190, speedSpread: 260, gravity: 620, durationMin: 1500, durationSpread: 700 },
  // 第二波：补爆。延迟 240ms 跟进、初速度更小，像"余波"填补近处空隙
  { count: 26, delayMin: 240, delaySpread: 140, speedMin: 150, speedSpread: 180, gravity: 560, durationMin: 1300, durationSpread: 500 },
];

/** 每个粒子动画的关键帧采样点数。16 点足够平滑（60fps 下人眼无法分辨折线） */
const KEYFRAME_SAMPLES = 16;

/** 清扫缓冲：最长动画结束后再等 120ms 才移除 DOM，防止最后一帧被提前清掉 */
const SWEEP_BUFFER_MS = 120;

/** 粒子爆发出射点（相对彩带层）——对勾图标中心略偏上 */
const ORIGIN_X_RATIO = 0.5;
const ORIGIN_Y_RATIO = 0.42;

type PieceSpec = {
  readonly width: number;
  readonly height: number;
  readonly color: string;
  readonly radius: number;
  readonly keyframes: Keyframe[];
  readonly delay: number;
  readonly duration: number;
};

function randomBetween(min: number, spread: number): number {
  return min + Math.random() * spread;
}

/**
 * 按抛物体公式采样关键帧。
 *   x(t) = vx · t
 *   y(t) = vy · t + ½ · g · t²
 * 再加两个"彩带感"修饰：
 *   - rotate：匀速自旋（240°–720°，方向随机）
 *   - scaleY：按 cos 曲线翻转，模拟纸片在空中翻面的明暗变化
 */
function buildPiece(burst: BurstSpec, originX: number, originY: number): PieceSpec {
  const angle = Math.random() * Math.PI * 2;
  const speed = randomBetween(burst.speedMin, burst.speedSpread);
  const duration = randomBetween(burst.durationMin, burst.durationSpread);
  const durationSec = duration / 1000;
  const vx = Math.cos(angle) * speed;
  const vy = Math.sin(angle) * speed;
  const spin = (240 + Math.random() * 480) * (Math.random() < 0.5 ? -1 : 1);
  const flips = 1.5 + Math.random() * 2.5; // 翻转次数

  const keyframes: Keyframe[] = [];
  for (let sample = 0; sample <= KEYFRAME_SAMPLES; sample += 1) {
    const progress = sample / KEYFRAME_SAMPLES;
    const t = progress * durationSec;
    const x = originX + vx * t;
    const y = originY + vy * t + 0.5 * burst.gravity * t * t;
    const rotate = spin * progress;
    const flip = Math.cos(progress * flips * Math.PI * 2); // 1 → 0 → -1 → 0 → 1
    // 前 72% 全程可见，最后 28% 线性淡出——粒子是"飞完消失"，不是中途蒸发
    const opacity = progress < 0.72 ? 1 : 1 - (progress - 0.72) / 0.28;
    keyframes.push({
      transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${rotate.toFixed(1)}deg) scaleY(${flip.toFixed(3)})`,
      opacity,
    });
  }

  return {
    width: randomBetween(5, 4),       // 5–9px 宽
    height: randomBetween(2.5, 2),    // 2.5–4.5px 高——细长条才有"彩带纸屑"感
    color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
    radius: randomBetween(0.5, 1.5),
    keyframes,
    delay: randomBetween(burst.delayMin, burst.delaySpread),
    duration,
  };
}

/**
 * 在 host 元素内放一场彩带。
 * host 需要是 position:relative 的定位容器（彩带层 absolute inset:0 铺满）。
 * 返回句柄，调用方负责在离场 / 重试时 cancel()。
 */
export function runCompletionConfetti(host: HTMLElement): CompletionConfettiHandle {
  const rect = host.getBoundingClientRect();
  const originX = rect.width * ORIGIN_X_RATIO;
  const originY = rect.height * ORIGIN_Y_RATIO;

  const layer = document.createElement("div");
  layer.className = "completion-confetti";
  layer.setAttribute("aria-hidden", "true");
  host.appendChild(layer);

  const animations: Animation[] = [];
  let longest = 0;

  for (const burst of BURSTS) {
    for (let index = 0; index < burst.count; index += 1) {
      const piece = buildPiece(burst, originX, originY);
      const element = document.createElement("span");
      element.className = "completion-confetti-piece";
      element.style.width = `${piece.width}px`;
      element.style.height = `${piece.height}px`;
      element.style.background = piece.color;
      element.style.borderRadius = `${piece.radius}px`;
      layer.appendChild(element);

      // easing 用 linear：运动曲线已经编码在关键帧里，再叠加缓动会二次扭曲物理
      const animation = element.animate(piece.keyframes, {
        duration: piece.duration,
        delay: piece.delay,
        easing: "linear",
        fill: "both",
      });
      animations.push(animation);
      longest = Math.max(longest, piece.delay + piece.duration);
    }
  }

  const sweeper = window.setTimeout(() => {
    animations.forEach((animation) => animation.cancel());
    layer.remove();
  }, longest + SWEEP_BUFFER_MS);

  return {
    cancel() {
      window.clearTimeout(sweeper);
      animations.forEach((animation) => animation.cancel());
      layer.remove();
    },
  };
}
