// Quick setup wizard (opened on first install by the background): language,
// faction backend, Intrastek key, features, done. The step lives in the hash
// (#step-N) so the reload after a language change stays on it.
import { LANGUAGE_DEFAULT, LANGUAGE_KEY } from '../i18n/core';
import { initLang } from '../i18n/load';
import { setupEn, tSetup } from '../i18n/pages-setup';
import { applyI18n, requireEl } from '../ui/dom';
import { factionConnectionForm, intrastekConnectionForm } from '../ui/connections';
import { featureList, languageSelect, type Section } from '../ui/features';
import { getLocal } from '../content/shared/ext-storage';

const STEPS = 5;
const SECTION_STEP: Record<Section, number> = { factions: 2, intrastek: 3 };

function currentStep(): number {
  const n = Number(/^#step-(\d)$/.exec(location.hash)?.[1]);
  return n >= 1 && n <= STEPS ? n : 1;
}

function go(step: number): void {
  location.hash = `step-${step}`;
}

function route(focus = false): void {
  const step = currentStep();
  for (const section of Array.from(document.querySelectorAll<HTMLElement>('[data-step]'))) {
    section.hidden = section.dataset.step !== String(step);
  }
  for (const [i, link] of Array.from(document.querySelectorAll<HTMLAnchorElement>('.stepper a')).entries()) {
    link.parentElement?.classList.toggle('is-done', i + 1 < step);
    if (i + 1 === step) link.setAttribute('aria-current', 'step');
    else link.removeAttribute('aria-current');
  }
  requireEl<HTMLButtonElement>('back').hidden = step === 1;
  requireEl<HTMLButtonElement>('next').hidden = step === STEPS;
  if (focus) requireEl(`h-step-${step}`).focus();
}

async function init(): Promise<void> {
  await initLang(() => location.reload());
  applyI18n(tSetup, setupEn);
  document.title = tSetup('setupTitle');

  const stored = await getLocal({ [LANGUAGE_KEY]: LANGUAGE_DEFAULT as string });
  const lang = languageSelect(stored?.[LANGUAGE_KEY]);
  lang.setAttribute('aria-labelledby', 'h-step-1');
  requireEl('languageBody').appendChild(lang);
  requireEl('factionsBody').appendChild(factionConnectionForm());
  requireEl('intrastekBody').appendChild(intrastekConnectionForm({ combined: true, advancedUrl: true }));
  requireEl('featuresBody').appendChild(
    featureList({ search: false, openSection: (section) => go(SECTION_STEP[section]) }),
  );

  requireEl('back').addEventListener('click', () => go(currentStep() - 1));
  requireEl('next').addEventListener('click', () => go(currentStep() + 1));
  window.addEventListener('hashchange', () => route(true));
  route();
}

void init();
