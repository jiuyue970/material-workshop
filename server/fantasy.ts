// Fantasy 摄影模拟（fantasy-photography-simulation skill）的服务端实现。
// 规则源：skills/fantasy-photography-simulation/SKILL.md —— 把「相机气质 + 地点/题材」
// 按 SKILL 的硬规则确定性转成图像模型 prompt（3:4 竖版摄影拼图，2-4 张同地点 panel）。
// 与 LLM 无关：这里不解析 SKILL.md，而是把 SKILL 的「提示词生成规则」「相机气质」
// 「摄影质感」「构图与现场感」的必须词/禁止词做成结构化模板，保证每条 prompt 合规。

export type FantasyCamera = 'auto' | 'hasselblad' | 'leica' | 'ricoh';

export interface FantasyEntry {
  /** 去掉编号与相机词之后的原始描述（地点 + 题材）。 */
  subject: string;
  /** 该条目最终使用的相机气质。 */
  camera: Exclude<FantasyCamera, 'auto'>;
  /** 原始输入行（含编号前缀）。 */
  raw: string;
}

const CAMERA_HINTS: Array<{ camera: Exclude<FantasyCamera, 'auto'>; pattern: RegExp }> = [
  { camera: 'hasselblad', pattern: /哈苏|hasselblad/i },
  { camera: 'leica', pattern: /徕卡|莱卡|leica/i },
  { camera: 'ricoh', pattern: /理光|ricoh|gr\s*[3x]?/i },
];

/** SKILL「提示词生成规则」要求必须写入的质感词。 */
const MANDATORY_TERMS = [
  'photobook-quality travel documentary photography collage',
  'one dominant cover-grade main photo',
  'subdued saturation, weighted shadows, soft controlled highlights',
  'foreground occlusion, edge crop, layered depth, off-center subject',
  'not a postcard, not a tourism advertisement, not a checklist of landmarks',
];

/** SKILL「摄影质感 / 构图与现场感」的硬约束（写成否定式交给图像模型）。 */
const QUALITY_TERMS = [
  'natural exposure, clear air, luminous and transparent',
  'real documentary photography base, very light film grain',
  'restrained cinematic color grade, real environment colors',
  'muted blues, natural olive greens, warm golden highlights, clean cyan shadows',
  'real-life candid moments, people met by chance, not posed models',
  'sense of life flow and video storyboard feel',
  'deep shadows with detail, soft highlights that never blow out',
  'no heavy retro filter, no gray haze, no dirty yellow tint',
  'no HDR look, no oversharpening, no oversaturation',
  'no AI glossy skin, no excessive bokeh',
  'no postcard blue sky, no stock-photo look, no scenic official photo',
];

const CAMERA_DNA: Record<Exclude<FantasyCamera, 'auto'>, string> = {
  hasselblad: 'Hasselblad medium-format airiness, calm and restrained composition, pure colors with relaxed tonal layers, natural fine detail, never harshly sharp',
  leica: 'Leica decisive-moment street photography, clear figure-environment relationship, candid documentary feel, beautiful shadow and highlight balance',
  ricoh: 'Ricoh GR 28mm wide observational feel, casual but accurate framing, everyday life flow, video-still documentary energy',
};

/** 未指定相机时，按 SKILL「相机气质」的适用场景自动选择。 */
export function pickCamera(text: string, fallback: FantasyCamera): Exclude<FantasyCamera, 'auto'> {
  const hint = CAMERA_HINTS.find((item) => item.pattern.test(text));
  if (hint) return hint.camera;
  if (fallback !== 'auto') return fallback;
  if (/建筑|自然|山|海|湖|江|水乡|园林|岸边|寺庙|高原|雪山|草原|安静/i.test(text)) return 'hasselblad';
  if (/街头|城市|旧城|雨夜|光影|胡同|巷子|夜市|人文/i.test(text)) return 'leica';
  if (/日常|散步|电车|小城|随拍|生活|旅行/i.test(text)) return 'ricoh';
  return 'leica';
}

/** 识别行首的编号前缀：1、 1. 1) 1: 1 等。返回 { number, rest } 或 null。 */
function matchNumberPrefix(line: string): { rest: string } | null {
  const match = line.match(/^\s*\d+\s*[、.．,，:：)）\s]\s*(.+)$/);
  return match ? { rest: match[1] } : null;
}

/** 去掉描述里的相机词与残留分隔符，避免污染地点/题材文本。 */
function stripCameraWords(text: string) {
  return text
    .replace(/(哈苏|徕卡|莱卡|理光|hasselblad|leica|ricoh|gr\s*[3x]?)/gi, ' ')
    .replace(/[、/\|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析多行输入为条目列表。支持两种格式（SKILL「输入解析」）：
 * - 低输入单行：`徕卡 / 街头 / 北京`（每行一个条目）
 * - 编号批量：`1、北京胡同` / `2. 杭州西湖`（编号数量 = 最终图像数量）
 * 每行恰好一个条目；编号前缀会被去掉，相机词会被识别并剥离。
 */
export function parseFantasyEntries(text: string, camera: FantasyCamera): FantasyEntry[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 10)
    .map((line) => {
      const body = matchNumberPrefix(line)?.rest ?? line;
      const detected = pickCamera(body, camera);
      return { subject: stripCameraWords(body), camera: detected, raw: line };
    })
    .filter((entry) => entry.subject.length > 0);
}

/** 地点理解：把地点/题材原文并入 prompt，保留中文地点表达让图像模型理解。 */
function locationPhrase(entry: FantasyEntry) {
  const subject = entry.subject.trim();
  return subject ? `location and subject: ${subject}, everyday life and real spatial scale, landmarks only as subtle background or edge clues` : '';
}

/** 按 SKILL「提示词生成规则」组装最终图像 prompt。 */
export function buildFantasyPrompt(entry: FantasyEntry) {
  return [
    'one 3:4 vertical photography collage made of 2-4 photo panels, all from the same place, same theme, same continuous time and same color language',
    'panels with clear hierarchy, not mechanically equal, not a template grid, varied camera positions and framings between panels',
    `camera character: ${CAMERA_DNA[entry.camera]}`,
    locationPhrase(entry),
    MANDATORY_TERMS.join(', '),
    QUALITY_TERMS.join(', '),
  ].filter(Boolean).join(', ');
}

/** 摄影模拟默认尺寸：3:4 竖版（16 的倍数，兼容常见图像模型尺寸要求）。 */
export const FANTASY_DEFAULT_SIZE = { width: 1152, height: 1536 } as const;
