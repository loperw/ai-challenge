// getRandomValues is available on HTTP VPN origins, unlike randomUUID.
if (!crypto.randomUUID) crypto.randomUUID = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
if (window.serviceConfig?.enabled) {
  const config = window.serviceConfig;
  const select = document.querySelector('#model');
  const option = new Option(config.model, config.model, true, true);
  option.dataset.provider = 'local';
  select.replaceChildren(option);
  const output = document.querySelector('#maxTokens');
  output.max = config.output; output.value = config.output;
  document.querySelector('label[for="maxTokens"] span').textContent = 'Лимит токенов ответа';
  document.querySelector('label[for="maxTokens"] small').textContent = `До ${config.output} токенов в ответе. Контекст диалога — до ${config.context} токенов.`;
  output.placeholder = `До ${config.output}`;
  const description = select.closest('label')?.querySelector('small');
  if (description) description.textContent = 'Модель работает на вашем VPS. Доступ к чату — через VPN.';
}
