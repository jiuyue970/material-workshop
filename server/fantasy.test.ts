import { describe, expect, it } from 'vitest';
import { buildFantasyPrompt, parseFantasyEntries, pickCamera } from './fantasy.js';

describe('parseFantasyEntries', () => {
  it('解析编号批量输入：每行一个条目', () => {
    const entries = parseFantasyEntries('1、北京胡同\n2. 杭州西湖\n3）巴黎街头\n4) 重庆十八梯', 'auto');
    expect(entries.map((entry) => entry.subject)).toEqual(['北京胡同', '杭州西湖', '巴黎街头', '重庆十八梯']);
  });

  it('解析「相机 / 题材 / 地点」单行输入并剥离相机词与残留分隔符', () => {
    const entries = parseFantasyEntries('徕卡 / 街头 / 北京\n哈苏 / 湖面与绿色 / 杭州西湖', 'auto');
    expect(entries.map((entry) => entry.camera)).toEqual(['leica', 'hasselblad']);
    expect(entries[0].subject).toBe('街头 北京');
    expect(entries[0].subject).not.toMatch(/徕卡|leica|[/、|]/);
  });

  it('「杭州西湖」自动匹配哈苏（湖题材），「北京胡同」匹配徕卡', () => {
    expect(pickCamera('杭州西湖', 'auto')).toBe('hasselblad');
    expect(pickCamera('北京胡同', 'auto')).toBe('leica');
  });

  it('用户指定的相机覆盖行内未指定相机的条目', () => {
    const entries = parseFantasyEntries('雨夜街头 / 东京', 'ricoh');
    expect(entries[0].camera).toBe('ricoh');
  });

  it('忽略空行并限制最多 10 条', () => {
    const lines = Array.from({ length: 15 }, (_unused, index) => `${index + 1}、地点${index}`).join('\n');
    const entries = parseFantasyEntries(lines, 'auto');
    expect(entries).toHaveLength(10);
  });
});

describe('pickCamera', () => {
  it('按题材自动选择：湖/山 → 哈苏，街头 → 徕卡，日常 → 理光', () => {
    expect(pickCamera('杭州西湖 湖面与绿色', 'auto')).toBe('hasselblad');
    expect(pickCamera('北京胡同街头', 'auto')).toBe('leica');
    expect(pickCamera('小城日常散步', 'auto')).toBe('ricoh');
  });
});

describe('buildFantasyPrompt', () => {
  it('包含 SKILL 要求的全部必须词与 3:4 拼图结构', () => {
    const prompt = buildFantasyPrompt({ subject: '北京胡同', camera: 'leica', raw: '北京胡同' });
    expect(prompt).toContain('3:4');
    expect(prompt).toContain('2-4 photo panels');
    expect(prompt).toContain('photobook-quality travel documentary photography collage');
    expect(prompt).toContain('one dominant cover-grade main photo');
    expect(prompt).toContain('subdued saturation, weighted shadows, soft controlled highlights');
    expect(prompt).toContain('foreground occlusion, edge crop, layered depth, off-center subject');
    expect(prompt).toContain('not a postcard, not a tourism advertisement, not a checklist of landmarks');
    expect(prompt).toContain('北京胡同');
  });

  it('相机气质写入具体镜头语言（透视/构图习惯），而不是只用滤镜或颗粒标签', () => {
    const prompt = buildFantasyPrompt({ subject: '街头', camera: 'hasselblad', raw: '哈苏 / 街头' });
    expect(prompt).toContain('medium-format airiness');
    expect(prompt).toContain('calm and restrained composition');
    // 质感词只以「禁用」形式出现：禁止重滤镜，颗粒必须是「很轻的胶片气息」
    expect(prompt).toContain('no heavy retro filter');
    expect(prompt).toContain('very light film grain');
  });
});
