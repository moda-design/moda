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
  canvasStateSummary: (ref: string) => `/v1/canvases/${enc(ref)}/state/summary`,
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

  // Asset search (Canvas Actions resource verb; /v1/files list/show/download was NOT built in
  // the prototype — a recorded parity exception)
  assetsSearch: () => '/v1/assets/search',

  // Team templates (template canvases the team starts new work from)
  templateList: () => '/v1/templates',
  // Drive (folders, placement, and per-item visibility across canvases, files, and folders).
  // `item_ref` is a typed wire id: fld_… | cvs_… | file_….
  driveFolders: () => '/v1/drive/folders',
  driveFolderCreate: () => '/v1/drive/folders',
  driveTree: () => '/v1/drive/tree',
  driveItemMove: (ref: string) => `/v1/drive/items/${enc(ref)}/move`,
  driveItem: (ref: string) => `/v1/drive/items/${enc(ref)}`,

  // Brand kits
  brandList: () => '/v1/brand-kits',
  brandShow: (ref: string) => `/v1/brand-kits/${enc(ref)}`,
  brandCreate: () => '/v1/brand-kits',
  brandUpdate: (ref: string) => `/v1/brand-kits/${enc(ref)}`,
  brandImages: (ref: string) => `/v1/brand-kits/${enc(ref)}/images`,
  brandImage: (ref: string, imageId: string) => `/v1/brand-kits/${enc(ref)}/images/${enc(imageId)}`,

  // Tasks (Omni escalation lane)
  taskStart: () => '/v1/tasks',
  taskShow: (ref: string) => `/v1/tasks/${enc(ref)}`,
  taskCancel: (ref: string) => `/v1/tasks/${enc(ref)}/cancel`,
  taskList: () => '/v1/tasks',

  // Web research (metered lane; provider-neutral by contract)
  webSearch: () => '/v1/web/search',
  webRead: () => '/v1/web/read',

  // Websites (deterministic static-site lane — v1: single-page HTML sites on *.moda.page)
  websiteList: () => '/v1/websites',
  websiteCreate: () => '/v1/websites',
  websiteShow: (id: string) => `/v1/websites/${enc(id)}`,
  websiteContent: (id: string) => `/v1/websites/${enc(id)}/content`,
  websitePages: (id: string) => `/v1/websites/${enc(id)}/pages`,
  websitePageContent: (id: string) => `/v1/websites/${enc(id)}/pages/content`,
  websiteScreenshot: (id: string) => `/v1/websites/${enc(id)}/screenshot`,
  websitePublish: (id: string) => `/v1/websites/${enc(id)}/publish`,
  websiteUnpublish: (id: string) => `/v1/websites/${enc(id)}/unpublish`,

  // Canvas page import + instructions + brand guides (wave-2 facade lifts)
  canvasImportPages: (ref: string) => `/v1/canvases/${enc(ref)}/import-pages`,
  canvasInstructions: (ref: string) => `/v1/canvases/${enc(ref)}/instructions`,
  brandGuides: (ref: string) => `/v1/brand-kits/${enc(ref)}/guides`,
  brandGuide: (ref: string, id: string) => `/v1/brand-kits/${enc(ref)}/guides/${enc(id)}`,
  remix: () => '/v1/remix',
  canvasImportPptx: () => '/v1/canvases/import-pptx',
  canvasImportPptxStatus: (jobId: string) => `/v1/canvases/import-pptx/${enc(jobId)}`,

  // Media (NEW metered lane)
  mediaGenerateImage: () => '/v1/media/generate-image',
  mediaEditImage: () => '/v1/media/edit-image',
  mediaGenerateVideo: () => '/v1/media/generate-video',
  mediaUpscale: () => '/v1/media/upscale',
  mediaUpscaleVideo: () => '/v1/media/upscale-video',
  mediaRemoveBackground: () => '/v1/media/remove-background',
  mediaModels: () => '/v1/media/models',

  // Account
  organizations: () => '/v1/organizations',
  credits: () => '/v1/credits',
  usage: () => '/v1/usage',
} as const;

/** Path (on the web app, not the API) of the CLI key-mint page — PR-B's page. */
export const MINT_PAGE_PATH = '/cli/auth';
