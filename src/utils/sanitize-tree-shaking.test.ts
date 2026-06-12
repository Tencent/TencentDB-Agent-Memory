import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Tree-shaking Verification', () => {
  it('should ensure looksLikePromptInjection is preserved in the final dist bundle', () => {
    // 使用 process.cwd() 绝对能精准定位到项目根目录下的 dist/index.mjs
    const distPath = path.resolve(process.cwd(), 'dist/index.mjs');

    // 1. 验证构建产物文件确实存在
    const fileExists = fs.existsSync(distPath);
    expect(fileExists).toBe(true);

    if (fileExists) {
      // 2. 读取打包产物内容
      const bundleContent = fs.readFileSync(distPath, 'utf8');

      // 3. 断言最终产物中依然保留了 looksLikePromptInjection
      expect(bundleContent).toContain('looksLikePromptInjection');
    }
  });
});