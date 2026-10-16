// Test-only stand-in for src/components/AdminLoginForm.tsx: records the props
// the login page passes, so a check can see exactly what reaches the browser.
import { createElement } from 'react';

export function AdminLoginForm(props) {
  ((globalThis.__adminCheck ??= {}).loginFormProps ??= []).push(props);
  return createElement('div', { 'data-login-form': '' });
}
