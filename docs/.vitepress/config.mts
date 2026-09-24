import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(defineConfig({
  lang: 'it-IT',
  title: 'TeamsRelay',
  description: 'Microsoft Teams sul telefono tramite un browser remoto self-hosted',
  cleanUrls: true,
  lastUpdated: true,
  head: [['link', { rel: 'icon', href: '/icon-192.png' }]],
  themeConfig: {
    logo: '/icon-192.png',
    nav: [
      { text: 'Guida', link: '/guida/introduzione' },
      { text: 'Riferimento', link: '/riferimento/architettura' },
      { text: 'Appendici', link: '/appendici/inoltro-email' },
    ],
    sidebar: [
      {
        text: 'Guida',
        items: [
          { text: 'Introduzione', link: '/guida/introduzione' },
          { text: 'Installazione', link: '/guida/installazione' },
          { text: 'Configurazione', link: '/guida/configurazione' },
          { text: "App sul telefono", link: '/guida/telefono' },
          { text: 'Uso quotidiano', link: '/guida/uso' },
          { text: 'Desktop remoto', link: '/guida/desktop-remoto' },
          { text: 'Deploy automatico', link: '/guida/deploy' },
          { text: 'Sviluppo in locale', link: '/guida/sviluppo-locale' },
          { text: 'Manutenzione e problemi', link: '/guida/manutenzione' },
        ],
      },
      {
        text: 'Riferimento',
        items: [
          { text: 'Architettura', link: '/riferimento/architettura' },
          { text: 'API della web app', link: '/riferimento/api' },
          { text: 'Selettori di Teams', link: '/riferimento/selettori' },
          { text: 'Sicurezza', link: '/riferimento/sicurezza' },
          { text: 'Limiti noti', link: '/riferimento/limiti' },
        ],
      },
      {
        text: 'Appendici',
        items: [
          { text: 'Inoltrare le email', link: '/appendici/inoltro-email' },
          { text: 'Copiare le riunioni', link: '/appendici/copia-riunioni' },
        ],
      },
    ],
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: 'Cerca', buttonAriaLabel: 'Cerca' },
          modal: { noResultsText: 'Nessun risultato per', resetButtonTitle: 'Cancella', footer: { selectText: 'apri', navigateText: 'scorri', closeText: 'chiudi' } },
        },
      },
    },
    outline: { label: 'In questa pagina', level: [2, 3] },
    docFooter: { prev: 'Precedente', next: 'Successiva' },
    lastUpdated: { text: 'Aggiornato' },
    darkModeSwitchLabel: 'Tema',
    sidebarMenuLabel: 'Menu',
    returnToTopLabel: 'Torna su',
    footer: { message: 'Progetto non affiliato né approvato da Microsoft. "Microsoft Teams" è un marchio di Microsoft.' },
  },
  mermaid: {},
}))
