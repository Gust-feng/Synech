type HomeDayPeriod =
  | 'late-night'
  | 'early-morning'
  | 'morning'
  | 'noon'
  | 'afternoon'
  | 'evening'
  | 'night'

export interface HomeAmbientCopyPair {
  readonly lead: string
  readonly idleTail: string
  readonly activeTail: string
}

const TIME_COPIES: Readonly<Record<HomeDayPeriod, readonly HomeAmbientCopyPair[]>> = {
  'late-night': [
    {
      lead: '夜深了，',
      idleTail: '今晚想从哪里开始？',
      activeTail: '今晚就从这件事开始。',
    },
    {
      lead: '这么晚了，',
      idleTail: '还想把哪件事理清楚？',
      activeTail: '这件事开始有了头绪。',
    },
  ],
  'early-morning': [
    {
      lead: '天刚亮，',
      idleTail: '今天想先做什么？',
      activeTail: '今天正好从这件事出发。',
    },
    {
      lead: '清晨很安静，',
      idleTail: '今天想从哪件事开始？',
      activeTail: '它已经有了今天的起点。',
    },
  ],
  morning: [
    {
      lead: '上午的时间还长，',
      idleTail: '今天想先处理哪件事？',
      activeTail: '这件事可以从容开始。',
    },
    {
      lead: '一个上午才开始，',
      idleTail: '今天想把什么向前推进？',
      activeTail: '它正变成接下来的一步。',
    },
  ],
  noon: [
    {
      lead: '中午了，',
      idleTail: '接下来想处理什么？',
      activeTail: '这件事让下午有了安排。',
    },
    {
      lead: '过了正午，',
      idleTail: '今天还想为哪件事留出位置？',
      activeTail: '它已经为下午留好了位置。',
    },
  ],
  afternoon: [
    {
      lead: '下午了，',
      idleTail: '今天还有什么值得完成？',
      activeTail: '这件事正变成下一步。',
    },
    {
      lead: '下午的时间还长，',
      idleTail: '今天想让哪件事更清楚？',
      activeTail: '它正在变得清楚。',
    },
  ],
  evening: [
    {
      lead: '天快黑了，',
      idleTail: '今晚想为哪件事留一点时间？',
      activeTail: '这件事正好在今天有了着落。',
    },
    {
      lead: '傍晚了，',
      idleTail: '今晚还想把什么向前推进？',
      activeTail: '它已经向前迈了一步。',
    },
  ],
  night: [
    {
      lead: '夜晚刚开始，',
      idleTail: '今晚想做点什么？',
      activeTail: '这件事值得从现在开始。',
    },
    {
      lead: '夜还长，',
      idleTail: '今天还想把什么慢慢完成？',
      activeTail: '它正在向一个结果靠近。',
    },
  ],
}

const GENERAL_COPIES: readonly HomeAmbientCopyPair[] = [
  {
    lead: '事情不总要从答案开始，',
    idleTail: '今天想先问问什么？',
    activeTail: '第一步已经从这里出现。',
  },
  {
    lead: '有些念头还没有名字，',
    idleTail: '今天想先让哪一个留下？',
    activeTail: '它已经有了可以继续的形状。',
  },
  {
    lead: '还没有想清楚的事情，',
    idleTail: '今天想先从哪里看起？',
    activeTail: '模糊的部分正在变得清楚。',
  },
  {
    lead: '不必急着把一切说清楚，',
    idleTail: '今天想先整理什么？',
    activeTail: '这件事已经可以开始整理。',
  },
  {
    lead: '一个想法不必等到完整，',
    idleTail: '今天想先把它写下来吗？',
    activeTail: '这个想法正在变得完整。',
  },
  {
    lead: '有些答案需要寻找，',
    idleTail: '今天想先从哪一步开始？',
    activeTail: '寻找已经有了下一步。',
  },
] as const

const TIME_COPY_WEIGHT = 60

/** 选择记忆：key 为「年-月-日-时段」选择周期，copy 为上次展示文案的身份。 */
export interface HomeAmbientCopyMemory {
  readonly key: string
  readonly copy: string
}

export interface HomeAmbientCopySelection {
  readonly copy: HomeAmbientCopyPair
  readonly key: string
}

/**
 * 触发逻辑：
 * - 同一选择周期（同一天同一时段）内文案保持稳定，不随重新进入变化；
 * - 进入新选择周期（跨时段或跨天）时，从候选池中排除上次展示的文案，
 *   避免相同文案连续出现；候选池只剩一条时允许回到上次文案。
 */
export function selectHomeAmbientCopy(
  now: Date = new Date(),
  memory?: HomeAmbientCopyMemory,
): HomeAmbientCopySelection {
  const period = homeDayPeriod(now.getHours())
  const key = [now.getFullYear(), now.getMonth() + 1, now.getDate(), period].join(':')
  const seed = hashText(key)
  const categoryRoll = seed % 100
  const candidates = categoryRoll < TIME_COPY_WEIGHT
    ? TIME_COPIES[period]
    : GENERAL_COPIES

  if (memory !== undefined && memory.key === key) {
    return { copy: pickCopy(candidates, seed), key }
  }

  return { copy: pickCopyAvoiding(candidates, seed, memory?.copy), key }
}

/** 文案身份：lead + idleTail 组成的稳定标识，用于防连续比较。 */
export function homeAmbientCopyIdentity(copy: HomeAmbientCopyPair): string {
  return `${copy.lead}${copy.idleTail}`
}

function homeDayPeriod(hour: number): HomeDayPeriod {
  if (hour < 5) return 'late-night'
  if (hour < 8) return 'early-morning'
  if (hour < 12) return 'morning'
  if (hour < 14) return 'noon'
  if (hour < 18) return 'afternoon'
  if (hour < 21) return 'evening'
  return 'night'
}

function pickCopy(copies: readonly HomeAmbientCopyPair[], seed: number): HomeAmbientCopyPair {
  return copies[seed % copies.length]!
}

/** 优先从候选池中排除上次展示的文案，剩余候选为空时才回到全集。 */
function pickCopyAvoiding(
  copies: readonly HomeAmbientCopyPair[],
  seed: number,
  previous?: string,
): HomeAmbientCopyPair {
  if (previous === undefined) return pickCopy(copies, seed)
  const rest = copies.filter((copy) => homeAmbientCopyIdentity(copy) !== previous)
  return rest.length > 0 ? pickCopy(rest, seed) : pickCopy(copies, seed)
}

function hashText(value: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}