/**
 * THE endpoint map — the single source of API paths (cli-repo-plan §4). Orchestrator ruling 8:
 * everything mounts inside the existing public sub-app under `/v1`; the earlier `/agent/v0`
 * working prefix is collapsed. A future rename is a one-file change here.
 */

/** Calendar pin for the public API (`Moda-Version` header, backend/app/api/public/versioning.py). */
export const API_VERSION_PIN = '2026-05-01';

/** CLI version headers on every response (backend/app/api/public/versioning.py CLI_*_HEADER). */
export const HEADER_CLI_LATEST = 'Moda-Cli-Latest-Version';
export const HEADER_CLI_MINIMUM = 'Moda-Cli-Minimum-Version';
/** Request header the server keys the below-minimum contract-floor error on (426 cli_update_required). */
export const HEADER_CLI_VERSION = 'Moda-Cli-Version';

const enc = encodeURIComponent;

export const endpoints = {
  // Identity
  whoami: () => '/v1/whoami',

  // Canvas Actions (authoring lane — the 8 extracted verbs + delete)
  canvasCreate: () => '/v1/canvases',
  canvasState: (ref: string) => `/v1/canvases/${enc(ref)}/state`,
  canvasMarkup: (ref: string) => `/v1/canvases/${enc(ref)}/markup`,
  canvasEdit: (ref: string) => `/v1/canvases/${enc(ref)}/edit`,
  canvasDeleteItems: (ref: string) => `/v1/canvases/${enc(ref)}/delete-items`,
  canvasLint: (ref: string) => `/v1/canvases/${enc(ref)}/lint`,
  canvasScreenshot: (ref: string) => `/v1/canvases/${enc(ref)}/screenshot`,
  canvasAddPages: (ref: string) => `/v1/canvases/${enc(ref)}/pages`,
  canvasDelete: (ref: string) => `/v1/canvases/${enc(ref)}`,

  // Canvas lifecycle (existing public REST, reused as-is)
  canvasList: () => '/v1/canvases',
  canvasSearch: () => '/v1/canvases/search',
  canvasShow: (ref: string) => `/v1/canvases/${enc(ref)}`,
  canvasPages: (ref: string) => `/v1/canvases/${enc(ref)}/pages`,
  canvasTokens: (ref: string) => `/v1/canvases/${enc(ref)}/tokens`,
  canvasRename: (ref: string) => `/v1/canvases/${enc(ref)}`,
  canvasShare: (ref: string) => `/v1/canvases/${enc(ref)}/share`,
  canvasExport: (ref: string) => `/v1/canvases/${enc(ref)}/export`,
  canvasExportStatus: (ref: string) => `/v1/canvases/${enc(ref)}/export-status`,
  shareLinkResolve: () => '/v1/share_links/resolve',

  // Uploads (existing public REST)
  uploads: () => '/v1/uploads',
  uploadFromUrl: () => '/v1/uploads/from-url',

  // Asset search (Canvas Actions resource verb — the only drive read that exists today;
  // /v1/files and /v1/folders were NOT built in the prototype: a recorded parity exception)
  assetsSearch: () => '/v1/assets/search',

  // Brand kits
  brandList: () => '/v1/brand-kits',
  brandShow: (ref: string) => `/v1/brand-kits/${enc(ref)}`,
  brandCreate: () => '/v1/brand-kits',

  // Tasks (Omni escalation lane)
  taskStart: () => '/v1/tasks',
  taskShow: (ref: string) => `/v1/tasks/${enc(ref)}`,
  taskCancel: (ref: string) => `/v1/tasks/${enc(ref)}/cancel`,
  taskList: () => '/v1/tasks',

  // Web research (metered lane; provider-neutral by contract)
  webSearch: () => '/v1/web/search',
  webRead: () => '/v1/web/read',

  // Media (NEW metered lane)
  mediaGenerateImage: () => '/v1/media/generate-image',
  mediaEditImage: () => '/v1/media/edit-image',
  mediaGenerateVideo: () => '/v1/media/generate-video',
  mediaUpscale: () => '/v1/media/upscale',
  mediaRemoveBackground: () => '/v1/media/remove-background',
  mediaModels: () => '/v1/media/models',

  // Account
  organizations: () => '/v1/organizations',
  credits: () => '/v1/credits',
  usage: () => '/v1/usage',
} as const;

/** Path (on the web app, not the API) of the CLI key-mint page — PR-B's page. */
export const MINT_PAGE_PATH = '/cli/auth';
