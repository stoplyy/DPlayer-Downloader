const TEST_FALLBACKS = {
  downloadQueueAdded: '已加入下载队列（$1 项）',
  hostRequiredNotice: '请先安装本机下载组件；安装完成后扩展会自动连接。扫描、预览和选择仍可使用',
  duplicateTask: '已存在相同任务（$1）',
};

export function t(key, substitutions = []) {
  const message = globalThis.chrome?.i18n?.getMessage?.(key, substitutions);
  if (message) return message;
  let fallback = TEST_FALLBACKS[key] || key;
  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  values.forEach((value, index) => { fallback = fallback.replaceAll(`$${index + 1}`, String(value)); });
  return fallback;
}

export function localizeDocument(root = globalThis.document) {
  if (!root) return;
  const locale = globalThis.chrome?.i18n?.getUILanguage?.() || 'zh-CN';
  root.documentElement?.setAttribute('lang', locale);
  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const attribute of ['title', 'aria-label', 'placeholder']) {
    const dataName = `i18n${attribute.replace(/(^|-)(.)/g, (_, __, letter) => letter.toUpperCase())}`;
    for (const element of root.querySelectorAll(`[data-${dataName}]`)) {
      element.setAttribute(attribute, t(element.dataset[dataName]));
    }
  }
}
