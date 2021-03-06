const cheerio = require('cheerio');
const ejs = require('ejs');
const fs = require('fs-extra-promise');
const ghpages = require('gh-pages');
const ignore = require('ignore');
const nunjucks = require('nunjucks');
const path = require('path');
const Promise = require('bluebird');
const ProgressBar = require('progress');
const walkSync = require('walk-sync');
const MarkBind = require('./lib/markbind/src/parser');

const _ = {};
_.difference = require('lodash/difference');
_.get = require('lodash/get');
_.has = require('lodash/has');
_.includes = require('lodash/includes');
_.isBoolean = require('lodash/isBoolean');
_.isUndefined = require('lodash/isUndefined');
_.noop = require('lodash/noop');
_.omitBy = require('lodash/omitBy');
_.startCase = require('lodash/startCase');
_.union = require('lodash/union');
_.uniq = require('lodash/uniq');

const url = {};
url.join = path.posix.join;

const delay = require('./util/delay');
const FsUtil = require('./util/fsUtil');
const logger = require('./util/logger');
const Page = require('./Page');
const Template = require('./template/template');

const CLI_VERSION = require('../package.json').version;

const {
  CONFIG_FOLDER_NAME,
  HEADING_INDEXING_LEVEL_DEFAULT,
  SITE_ASSET_FOLDER_NAME,
  TEMP_FOLDER_NAME,
  TEMPLATE_SITE_ASSET_FOLDER_NAME,
  ABOUT_MARKDOWN_FILE,
  BUILT_IN_PLUGIN_FOLDER_NAME,
  BUILT_IN_DEFAULT_PLUGIN_FOLDER_NAME,
  FAVICON_DEFAULT_PATH,
  FOOTER_PATH,
  INDEX_MARKDOWN_FILE,
  MARKBIND_PLUGIN_PREFIX,
  MARKBIND_WEBSITE_URL,
  PAGE_TEMPLATE_NAME,
  PROJECT_PLUGIN_FOLDER_NAME,
  SITE_CONFIG_NAME,
  SITE_DATA_NAME,
  LAYOUT_DEFAULT_NAME,
  LAYOUT_FOLDER_PATH,
  LAYOUT_SITE_FOLDER_NAME,
  USER_VARIABLES_PATH,
  WIKI_SITE_NAV_PATH,
  WIKI_FOOTER_PATH,
} = require('./constants');

function getBootswatchThemePath(theme) {
  return path.join(__dirname, '..', 'node_modules', 'bootswatch', 'dist', theme, 'bootstrap.min.css');
}

const SUPPORTED_THEMES_PATHS = {
  'bootswatch-cerulean': getBootswatchThemePath('cerulean'),
  'bootswatch-cosmo': getBootswatchThemePath('cosmo'),
  'bootswatch-flatly': getBootswatchThemePath('flatly'),
  'bootswatch-journal': getBootswatchThemePath('journal'),
  'bootswatch-litera': getBootswatchThemePath('litera'),
  'bootswatch-lumen': getBootswatchThemePath('lumen'),
  'bootswatch-lux': getBootswatchThemePath('lux'),
  'bootswatch-materia': getBootswatchThemePath('materia'),
  'bootswatch-minty': getBootswatchThemePath('minty'),
  'bootswatch-pulse': getBootswatchThemePath('pulse'),
  'bootswatch-sandstone': getBootswatchThemePath('sandstone'),
  'bootswatch-simplex': getBootswatchThemePath('simplex'),
  'bootswatch-sketchy': getBootswatchThemePath('sketchy'),
  'bootswatch-spacelab': getBootswatchThemePath('spacelab'),
  'bootswatch-united': getBootswatchThemePath('united'),
  'bootswatch-yeti': getBootswatchThemePath('yeti'),
};

const ABOUT_MARKDOWN_DEFAULT = '# About\n'
  + 'Welcome to your **About Us** page.\n';

const TOP_NAV_DEFAULT = '<header><navbar placement="top" type="inverse">\n'
  + '  <a slot="brand" href="{{baseUrl}}/index.html" title="Home" class="navbar-brand">'
  + '<i class="far fa-file-image"></i></a>\n'
  + '  <li><a href="{{baseUrl}}/index.html" class="nav-link">HOME</a></li>\n'
  + '  <li><a href="{{baseUrl}}/about.html" class="nav-link">ABOUT</a></li>\n'
  + '  <li slot="right">\n'
  + '    <form class="navbar-form">\n'
  + '      <searchbar :data="searchData" placeholder="Search" :on-hit="searchCallback"'
  + ' menu-align-right></searchbar>\n'
  + '    </form>\n'
  + '  </li>\n'
  + '</navbar></header>';

const MARKBIND_LINK_HTML = `<a href='${MARKBIND_WEBSITE_URL}'>MarkBind ${CLI_VERSION}</a>`;

function Site(rootPath, outputPath, onePagePath, forceReload = false, siteConfigPath = SITE_CONFIG_NAME) {
  this.rootPath = rootPath;
  this.outputPath = outputPath;
  this.tempPath = path.join(rootPath, TEMP_FOLDER_NAME);

  // MarkBind assets to be copied
  this.siteAssetsSrcPath = path.resolve(__dirname, '..', SITE_ASSET_FOLDER_NAME);
  this.siteAssetsDestPath = path.join(outputPath, TEMPLATE_SITE_ASSET_FOLDER_NAME);

  // Page template path
  this.pageTemplatePath = path.join(__dirname, PAGE_TEMPLATE_NAME);
  this.pageTemplate = ejs.compile(fs.readFileSync(this.pageTemplatePath, 'utf8'));
  this.pages = [];

  // Other properties
  this.addressablePages = [];
  this.baseUrlMap = new Set();
  this.forceReload = forceReload;
  this.onePagePath = onePagePath;
  this.plugins = {};
  this.siteConfig = {};
  this.siteConfigPath = siteConfigPath;
  this.userDefinedVariablesMap = {};
}

/**
 * Util Methods
 */

function rejectHandler(reject, error, removeFolders) {
  logger.warn(error);
  Promise.all(removeFolders.map(folder => fs.removeAsync(folder)))
    .then(() => {
      reject(error);
    })
    .catch((err) => {
      reject(new Error(`${error.message}\n${err.message}`));
    });
}

function setExtension(filename, ext) {
  return path.join(
    path.dirname(filename),
    path.basename(filename, path.extname(filename)) + ext,
  );
}

/**
 * Static method for initializing a markbind site.
 * Generate the site.json and an index.md file.
 *
 * @param rootPath
 * @param templatePath
 */
Site.initSite = function (rootPath, templatePath) {
  return new Promise((resolve, reject) => {
    new Template(rootPath, templatePath).init()
      .then(resolve)
      .catch((err) => {
        reject(new Error(`Failed to initialize site with given template with error: ${err.message}`));
      });
  });
};

Site.prototype.readSiteConfig = function (baseUrl) {
  return new Promise((resolve, reject) => {
    const siteConfigPath = path.join(this.rootPath, this.siteConfigPath);
    fs.readJsonAsync(siteConfigPath)
      .then((config) => {
        this.siteConfig = config;
        this.siteConfig.baseUrl = (baseUrl === undefined) ? this.siteConfig.baseUrl : baseUrl;
        this.siteConfig.enableSearch = (config.enableSearch === undefined) || config.enableSearch;
        resolve(this.siteConfig);
      })
      .catch((err) => {
        reject(new Error(`Failed to read the site config file '${this.siteConfigPath}' at`
          + `${this.rootPath}:\n${err.message}\nPlease ensure the file exist or is valid`));
      });
  });
};

Site.prototype.listAssets = function (fileIgnore) {
  return new Promise((resolve, reject) => {
    let files;
    try {
      files = walkSync(this.rootPath, { directories: false });
      resolve(fileIgnore.filter(files));
    } catch (error) {
      reject(error);
    }
  });
};

Site.prototype.createPage = function (config) {
  const sourcePath = path.join(this.rootPath, config.pageSrc);
  const tempPath = path.join(this.tempPath, config.pageSrc);
  const resultPath = path.join(this.outputPath, setExtension(config.pageSrc, '.html'));
  return new Page({
    baseUrl: this.siteConfig.baseUrl,
    baseUrlMap: this.baseUrlMap,
    content: '',
    pluginsContext: this.siteConfig.pluginsContext || {},
    faviconUrl: config.faviconUrl,
    frontmatter: config.frontmatter,
    globalOverride: this.siteConfig.globalOverride || {},
    pageTemplate: this.pageTemplate,
    plugins: this.plugins || {},
    rootPath: this.rootPath,
    enableSearch: this.siteConfig.enableSearch,
    searchable: this.siteConfig.enableSearch && config.searchable,
    src: config.pageSrc,
    layoutsAssetPath: path.relative(path.dirname(resultPath),
                                    path.join(this.siteAssetsDestPath, LAYOUT_SITE_FOLDER_NAME)),
    layout: config.layout,
    title: config.title || '',
    titlePrefix: this.siteConfig.titlePrefix,
    headingIndexingLevel: this.siteConfig.headingIndexingLevel || HEADING_INDEXING_LEVEL_DEFAULT,
    userDefinedVariablesMap: this.userDefinedVariablesMap,
    sourcePath,
    tempPath,
    resultPath,
    asset: {
      bootstrap: path.relative(path.dirname(resultPath),
                               path.join(this.siteAssetsDestPath, 'css', 'bootstrap.min.css')),
      bootstrapVue: path.relative(path.dirname(resultPath),
                                  path.join(this.siteAssetsDestPath, 'css', 'bootstrap-vue.min.css')),
      externalScripts: _.union(this.siteConfig.externalScripts, config.externalScripts),
      fontAwesome: path.relative(path.dirname(resultPath),
                                 path.join(this.siteAssetsDestPath, 'fontawesome', 'css', 'all.min.css')),
      glyphicons: path.relative(path.dirname(resultPath),
                                path.join(this.siteAssetsDestPath, 'glyphicons', 'css',
                                          'bootstrap-glyphicons.min.css')),
      highlight: path.relative(path.dirname(resultPath),
                               path.join(this.siteAssetsDestPath, 'css', 'github.min.css')),
      markbind: path.relative(path.dirname(resultPath),
                              path.join(this.siteAssetsDestPath, 'css', 'markbind.css')),
      pageNavCss: path.relative(path.dirname(resultPath),
                                path.join(this.siteAssetsDestPath, 'css', 'page-nav.css')),
      siteNavCss: path.relative(path.dirname(resultPath),
                                path.join(this.siteAssetsDestPath, 'css', 'site-nav.css')),
      bootstrapUtilityJs: path.relative(path.dirname(resultPath),
                                        path.join(this.siteAssetsDestPath, 'js', 'bootstrap-utility.min.js')),
      bootstrapVueJs: path.relative(path.dirname(resultPath),
                                    path.join(this.siteAssetsDestPath, 'js', 'bootstrap-vue.min.js')),
      polyfillJs: path.relative(path.dirname(resultPath),
                                path.join(this.siteAssetsDestPath, 'js', 'polyfill.min.js')),
      setup: path.relative(path.dirname(resultPath),
                           path.join(this.siteAssetsDestPath, 'js', 'setup.js')),
      vue: path.relative(path.dirname(resultPath),
                         path.join(this.siteAssetsDestPath, 'js', 'vue.min.js')),
      vueStrap: path.relative(path.dirname(resultPath),
                              path.join(this.siteAssetsDestPath, 'js', 'vue-strap.min.js')),
    },
  });
};

/**
 * Converts an existing Github wiki or docs folder to a MarkBind website.
 */
Site.prototype.convert = function () {
  return this.readSiteConfig()
    .then(() => this.collectAddressablePages())
    .then(() => this.addIndexPage())
    .then(() => this.addAboutPage())
    .then(() => this.addTopNavToDefaultLayout())
    .then(() => this.addFooterToDefaultLayout())
    .then(() => this.addSiteNavToDefaultLayout())
    .then(() => this.addDefaultLayoutToSiteConfig())
    .then(() => this.printBaseUrlMessage());
};

/**
 * Copies over README.md or Home.md to default index.md if present.
 */
Site.prototype.addIndexPage = function () {
  const indexPagePath = path.join(this.rootPath, INDEX_MARKDOWN_FILE);
  const fileNames = ['README.md', 'Home.md'];
  const filePath = fileNames.find(fileName => fs.existsSync(path.join(this.rootPath, fileName)));
  // if none of the files exist, do nothing
  if (_.isUndefined(filePath)) return Promise.resolve();
  return fs.copyAsync(path.join(this.rootPath, filePath), indexPagePath)
    .catch(() => Promise.reject(new Error(`Failed to copy over ${filePath}`)));
};

/**
 * Adds an about page to site if not present.
 */
Site.prototype.addAboutPage = function () {
  const aboutPath = path.join(this.rootPath, ABOUT_MARKDOWN_FILE);
  return fs.accessAsync(aboutPath)
    .catch(() => {
      if (fs.existsSync(aboutPath)) {
        return Promise.resolve();
      }
      return fs.outputFileAsync(aboutPath, ABOUT_MARKDOWN_DEFAULT);
    });
};

/**
 * Adds top navigation menu to default layout of site.
 */
Site.prototype.addTopNavToDefaultLayout = function () {
  const siteLayoutPath = path.join(this.rootPath, LAYOUT_FOLDER_PATH);
  const siteLayoutHeaderDefaultPath = path.join(siteLayoutPath, LAYOUT_DEFAULT_NAME, 'header.md');

  return fs.outputFileAsync(siteLayoutHeaderDefaultPath, TOP_NAV_DEFAULT);
};

/**
 * Adds a footer to default layout of site.
 */
Site.prototype.addFooterToDefaultLayout = function () {
  const footerPath = path.join(this.rootPath, FOOTER_PATH);
  const siteLayoutPath = path.join(this.rootPath, LAYOUT_FOLDER_PATH);
  const siteLayoutFooterDefaultPath = path.join(siteLayoutPath, LAYOUT_DEFAULT_NAME, 'footer.md');
  const wikiFooterPath = path.join(this.rootPath, WIKI_FOOTER_PATH);

  return fs.accessAsync(wikiFooterPath)
    .then(() => {
      const footerContent = fs.readFileSync(wikiFooterPath, 'utf8');
      const wrappedFooterContent = `<footer>\n\t${footerContent}\n</footer>`;
      return fs.outputFileAsync(siteLayoutFooterDefaultPath, wrappedFooterContent);
    })
    .catch(() => {
      if (fs.existsSync(footerPath)) {
        return fs.copyAsync(footerPath, siteLayoutFooterDefaultPath);
      }
      return Promise.resolve();
    });
};

/**
 * Adds a site navigation bar to the default layout of the site.
 */
Site.prototype.addSiteNavToDefaultLayout = function () {
  const siteLayoutPath = path.join(this.rootPath, LAYOUT_FOLDER_PATH);
  const siteLayoutSiteNavDefaultPath = path.join(siteLayoutPath, LAYOUT_DEFAULT_NAME, 'navigation.md');
  const wikiSiteNavPath = path.join(this.rootPath, WIKI_SITE_NAV_PATH);

  return fs.accessAsync(wikiSiteNavPath)
    .then(() => {
      const siteNavContent = fs.readFileSync(wikiSiteNavPath, 'utf8');
      const wrappedSiteNavContent = `<navigation>\n${siteNavContent}\n</navigation>`;
      logger.info(`Copied over the existing _Sidebar.md file to ${path.relative(
        this.rootPath, siteLayoutSiteNavDefaultPath)}`
        + 'Check https://markbind.org/userGuide/tweakingThePageStructure.html#site-navigation-menus\n'
        + 'for information on site navigation menus.');
      return fs.outputFileSync(siteLayoutSiteNavDefaultPath, wrappedSiteNavContent);
    })
    .catch(() => this.buildSiteNav(siteLayoutSiteNavDefaultPath));
};

/**
 * Builds a site navigation file from the directory structure of the site.
 * @param siteLayoutSiteNavDefaultPath
 */
Site.prototype.buildSiteNav = function (siteLayoutSiteNavDefaultPath) {
  let siteNavContent = '';
  this.addressablePages
    .filter(addressablePage => !addressablePage.src.startsWith('_'))
    .forEach((page) => {
      const addressablePagePath = path.join(this.rootPath, page.src);
      const relativePagePathWithoutExt = FsUtil.removeExtension(
        path.relative(this.rootPath, addressablePagePath));
      const pageName = _.startCase(FsUtil.removeExtension(path.basename(addressablePagePath)));
      const pageUrl = `{{ baseUrl }}/${relativePagePathWithoutExt}.html`;
      siteNavContent += `* [${pageName}](${pageUrl})\n`;
    });
  const wrappedSiteNavContent = `<navigation>\n${siteNavContent}\n</navigation>`;
  return fs.outputFileAsync(siteLayoutSiteNavDefaultPath, wrappedSiteNavContent);
};

/**
 * Applies the default layout to all addressable pages by modifying the site config file.
 */
Site.prototype.addDefaultLayoutToSiteConfig = function () {
  const configPath = path.join(this.rootPath, SITE_CONFIG_NAME);
  return fs.readJsonAsync(configPath)
    .then((config) => {
      const layoutObj = { glob: '**/*.+(md|mbd)', layout: LAYOUT_DEFAULT_NAME };
      config.pages.push(layoutObj);
      return fs.outputJsonAsync(configPath, config);
    });
};

Site.prototype.printBaseUrlMessage = function () {
  logger.info('The default base URL of your site is set to /\n'
    + 'You can change the base URL of your site by editing site.json\n'
    + 'Check https://markbind.org/userGuide/siteConfiguration.html for more information.');
  return Promise.resolve();
};

/**
 * Updates the paths to be traversed as addressable pages and returns a list of filepaths to be deleted
 */
Site.prototype.updateAddressablePages = function () {
  const oldAddressablePages = this.addressablePages.slice();
  this.collectAddressablePages();
  return _.difference(oldAddressablePages.map(page => page.src),
                      this.addressablePages.map(page => page.src))
    .map(filePath => setExtension(filePath, '.html'));
};

/**
 * Collects the paths to be traversed as addressable pages
 */
Site.prototype.collectAddressablePages = function () {
  const { pages } = this.siteConfig;
  const addressableGlobs = pages.filter(page => page.glob);
  this.addressablePages = pages.filter(page => page.src);
  const set = new Set();
  const duplicatePages = this.addressablePages
    .filter(page => set.size === set.add(page.src).size)
    .map(page => page.src);
  if (duplicatePages.length > 0) {
    return Promise.reject(
      new Error(`Duplicate page entries found in site config: ${_.uniq(duplicatePages).join(', ')}`));
  }
  const globPaths = addressableGlobs.reduce((globPages, addressableGlob) =>
    globPages.concat(walkSync(this.rootPath, {
      directories: false,
      globs: [addressableGlob.glob],
      ignore: [CONFIG_FOLDER_NAME],
    }).map(globPath => ({
      src: globPath,
      searchable: addressableGlob.searchable,
      layout: addressableGlob.layout,
      frontmatter: addressableGlob.frontmatter,
    }))), []);
  // Add pages collected by walkSync and merge properties for pages
  const filteredPages = {};
  globPaths.concat(this.addressablePages).forEach((page) => {
    const filteredPage = _.omitBy(page, _.isUndefined);
    if (page.src in filteredPages) {
      filteredPages[page.src] = { ...filteredPages[page.src], ...filteredPage };
    } else {
      filteredPages[page.src] = filteredPage;
    }
  });
  this.addressablePages = Object.values(filteredPages);

  return Promise.resolve();
};

Site.prototype.collectBaseUrl = function () {
  const candidates
    = walkSync(this.rootPath, { directories: false })
      .filter(x => x.endsWith(this.siteConfigPath))
      .map(x => path.resolve(this.rootPath, x));

  this.baseUrlMap = new Set(candidates.map(candidate => path.dirname(candidate)));

  return Promise.resolve();
};

/**
 * Collects the user defined variables map in the site/subsites
 */
Site.prototype.collectUserDefinedVariablesMap = function () {
  // The key is the base directory of the site/subsites,
  // while the value is a mapping of user defined variables
  this.userDefinedVariablesMap = {};
  const markbindVariable = { MarkBind: MARKBIND_LINK_HTML };

  this.baseUrlMap.forEach((base) => {
    const userDefinedVariables = {};
    Object.assign(userDefinedVariables, markbindVariable);

    let content;
    try {
      const userDefinedVariablesPath = path.resolve(base, USER_VARIABLES_PATH);
      content = fs.readFileSync(userDefinedVariablesPath, 'utf8');
    } catch (e) {
      content = '';
      logger.warn(e.message);
    }

    // This is to prevent the first nunjuck call from converting {{baseUrl}} to an empty string
    // and let the baseUrl value be injected later.
    userDefinedVariables.baseUrl = '{{baseUrl}}';
    this.userDefinedVariablesMap[base] = userDefinedVariables;

    const $ = cheerio.load(content);
    $('variable,span').each(function () {
      const name = $(this).attr('name') || $(this).attr('id');
      // Process the content of the variable with nunjucks, in case it refers to other variables.
      const html = nunjucks.renderString($(this).html(), userDefinedVariables);
      userDefinedVariables[name] = html;
    });
  });
};

/**
 * Collects the user defined variables map in the site/subsites
 * if there is a change in the variables file
 * @param filePaths array of paths corresponding to files that have changed
 */
Site.prototype.collectUserDefinedVariablesMapIfNeeded = function (filePaths) {
  const variablesPath = path.resolve(this.rootPath, USER_VARIABLES_PATH);
  if (filePaths.includes(variablesPath)) {
    this.collectUserDefinedVariablesMap();
    return true;
  }
  return false;
};

Site.prototype.generate = function (baseUrl) {
  const startTime = new Date();
  // Create the .tmp folder for storing intermediate results.
  fs.emptydirSync(this.tempPath);
  // Clean the output folder; create it if not exist.
  fs.emptydirSync(this.outputPath);
  logger.info(`Website generation started at ${startTime.toLocaleTimeString()}`);
  return new Promise((resolve, reject) => {
    this.readSiteConfig(baseUrl)
      .then(() => this.collectAddressablePages())
      .then(() => this.collectBaseUrl())
      .then(() => this.collectUserDefinedVariablesMap())
      .then(() => this.collectPlugins())
      .then(() => this.buildAssets())
      .then(() => this.buildSourceFiles())
      .then(() => this.copyMarkBindAsset())
      .then(() => this.copyFontAwesomeAsset())
      .then(() => this.copyLayouts())
      .then(() => this.updateSiteData())
      .then(() => {
        const endTime = new Date();
        const totalBuildTime = (endTime - startTime) / 1000;
        logger.info(`Website generation complete! Total build time: ${totalBuildTime}s`);
      })
      .then(resolve)
      .catch((error) => {
        rejectHandler(reject, error, [this.tempPath, this.outputPath]);
      });
  });
};

/**
 * Build all pages of the site
 */
Site.prototype.buildSourceFiles = function () {
  return new Promise((resolve, reject) => {
    logger.info('Generating pages...');
    this.generatePages()
      .then(() => fs.removeAsync(this.tempPath))
      .then(() => logger.info('Pages built'))
      .then(resolve)
      .catch((error) => {
        // if error, remove the site and temp folders
        rejectHandler(reject, error, [this.tempPath, this.outputPath]);
      });
  });
};

Site.prototype._rebuildAffectedSourceFiles = function (filePaths) {
  const filePathArray = Array.isArray(filePaths) ? filePaths : [filePaths];
  const uniquePaths = _.uniq(filePathArray);
  logger.info('Rebuilding affected source files');
  MarkBind.resetVariables();
  return new Promise((resolve, reject) => {
    this.regenerateAffectedPages(uniquePaths)
      .then(() => fs.removeAsync(this.tempPath))
      .then(resolve)
      .catch((error) => {
        // if error, remove the site and temp folders
        rejectHandler(reject, error, [this.tempPath, this.outputPath]);
      });
  });
};

/**
 * Rebuild pages that are affected by changes in filePaths
 * @param filePaths a single path or an array of paths corresponding to the files that have changed
 */
Site.prototype.rebuildAffectedSourceFiles
  = delay(Site.prototype._rebuildAffectedSourceFiles, 1000);

Site.prototype._rebuildSourceFiles = function () {
  logger.warn('Rebuilding all source files');
  return new Promise((resolve, reject) => {
    Promise.resolve('')
      .then(() => this.updateAddressablePages())
      .then(filesToRemove => this.removeAsset(filesToRemove))
      .then(() => this.buildSourceFiles())
      .then(resolve)
      .catch((error) => {
        // if error, remove the site and temp folders
        rejectHandler(reject, error, [this.tempPath, this.outputPath]);
      });
  });
};

/**
 * Rebuild all pages
 * @param filePaths a single path or an array of paths corresponding to the files that have changed
 */
Site.prototype.rebuildSourceFiles
  = delay(Site.prototype._rebuildSourceFiles, 1000);

Site.prototype._buildMultipleAssets = function (filePaths) {
  const filePathArray = Array.isArray(filePaths) ? filePaths : [filePaths];
  const uniquePaths = _.uniq(filePathArray);
  const ignoreConfig = this.siteConfig.ignore || [];
  const fileIgnore = ignore().add(ignoreConfig);
  const fileRelativePaths = uniquePaths.map(filePath => path.relative(this.rootPath, filePath));
  const copyAssets = fileIgnore.filter(fileRelativePaths)
    .map(asset => fs.copyAsync(path.join(this.rootPath, asset), path.join(this.outputPath, asset)));
  return Promise.all(copyAssets)
    .then(() => logger.info('Assets built'));
};

/**
 * Build/copy assets that are specified in filePaths
 * @param filePaths a single path or an array of paths corresponding to the assets to build
 */
Site.prototype.buildAsset
  = delay(Site.prototype._buildMultipleAssets, 1000);

Site.prototype._removeMultipleAssets = function (filePaths) {
  const filePathArray = Array.isArray(filePaths) ? filePaths : [filePaths];
  const uniquePaths = _.uniq(filePathArray);
  const fileRelativePaths = uniquePaths.map(filePath => path.relative(this.rootPath, filePath));
  const filesToRemove = fileRelativePaths.map(
    fileRelativePath => path.join(this.outputPath, fileRelativePath));
  const removeFiles = filesToRemove.map(asset => fs.removeAsync(asset));
  return Promise.all(removeFiles)
    .then(() => logger.info('Assets removed'));
};

/**
 * Remove assets that are specified in filePaths
 * @param filePaths a single path or an array of paths corresponding to the assets to remove
 */
Site.prototype.removeAsset
  = delay(Site.prototype._removeMultipleAssets, 1000);

Site.prototype.buildAssets = function () {
  logger.info('Building assets...');
  return new Promise((resolve, reject) => {
    const ignoreConfig = this.siteConfig.ignore || [];
    const outputFolder = path.relative(this.rootPath, this.outputPath);
    ignoreConfig.push(outputFolder); // ignore generated site folder
    const fileIgnore = ignore().add(ignoreConfig);
    // Scan and copy assets (excluding ignore files).
    this.listAssets(fileIgnore)
      .then(assets =>
        assets.map(asset => fs.copyAsync(path.join(this.rootPath, asset), path.join(this.outputPath, asset))),
      )
      .then(copyAssets => Promise.all(copyAssets))
      .then(() => logger.info('Assets built'))
      .then(resolve)
      .catch((error) => {
        rejectHandler(reject, error, []); // assets won't affect deletion
      });
  });
};

/**
 * Retrieves the correct plugin path for a plugin name, if not in node_modules
 * @param rootPath root of the project
 * @param plugin name of the plugin
 */
function getPluginPath(rootPath, plugin) {
  // Check in project folder
  const pluginPath = path.join(rootPath, PROJECT_PLUGIN_FOLDER_NAME, `${plugin}.js`);
  if (fs.existsSync(pluginPath)) {
    return pluginPath;
  }

  // Check in src folder
  const srcPath = path.join(__dirname, BUILT_IN_PLUGIN_FOLDER_NAME, `${plugin}.js`);
  if (fs.existsSync(srcPath)) {
    return srcPath;
  }

  // Check in default folder
  const defaultPath = path.join(__dirname, BUILT_IN_DEFAULT_PLUGIN_FOLDER_NAME, `${plugin}.js`);
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }

  return '';
}

/**
 * Finds plugins in the site's default plugin folder
 */
function findDefaultPlugins() {
  const globPath = path.join(__dirname, BUILT_IN_DEFAULT_PLUGIN_FOLDER_NAME);
  if (!fs.existsSync(globPath)) {
    return [];
  }
  return walkSync(globPath, {
    directories: false,
    globs: [`${MARKBIND_PLUGIN_PREFIX}*.js`],
  }).map(file => path.parse(file).name);
}

/**
 * Loads a plugin
 * @param plugin name of the plugin
 * @param isDefault whether the plugin is a default plugin
 */
Site.prototype.loadPlugin = function (plugin, isDefault) {
  try {
    // Check if already loaded
    if (this.plugins[plugin]) {
      return;
    }

    const pluginPath = getPluginPath(this.rootPath, plugin);
    if (isDefault && !pluginPath.startsWith(path.join(__dirname, BUILT_IN_DEFAULT_PLUGIN_FOLDER_NAME))) {
      logger.warn(`Default plugin ${plugin} will be overridden`);
    }

    // eslint-disable-next-line global-require, import/no-dynamic-require
    this.plugins[plugin] = require(pluginPath || plugin);
  } catch (e) {
    logger.warn(`Unable to load plugin ${plugin}, skipping`);
  }
};

/**
 * Load all plugins of the site
 */
Site.prototype.collectPlugins = function () {
  if (!this.siteConfig.plugins) {
    this.siteConfig.plugins = [];
  }

  module.paths.push(path.join(this.rootPath, 'node_modules'));

  const defaultPlugins = findDefaultPlugins();

  this.siteConfig.plugins
    .filter(plugin => !_.includes(defaultPlugins, plugin))
    .forEach(plugin => this.loadPlugin(plugin, false));

  const markbindPrefixRegex = new RegExp(`^${MARKBIND_PLUGIN_PREFIX}`);
  defaultPlugins
    .filter(plugin => !_.get(this.siteConfig,
                             ['pluginsContext', plugin.replace(markbindPrefixRegex, ''), 'off'],
                             false))
    .forEach(plugin => this.loadPlugin(plugin, true));
};

/**
 * Renders all pages specified in site configuration file to the output folder
 */
Site.prototype.generatePages = function () {
  // Run MarkBind include and render on each source file.
  // Render the final rendered page to the output folder.
  const { baseUrl, faviconPath } = this.siteConfig;
  const addressablePages = this.addressablePages || [];
  const builtFiles = new Set();
  const processingFiles = [];

  let faviconUrl;
  if (faviconPath) {
    faviconUrl = url.join('/', baseUrl, faviconPath);
    if (!fs.existsSync(path.join(this.rootPath, faviconPath))) {
      logger.warn(`${faviconPath} does not exist`);
    }
  } else if (fs.existsSync(path.join(this.rootPath, FAVICON_DEFAULT_PATH))) {
    faviconUrl = url.join('/', baseUrl, FAVICON_DEFAULT_PATH);
  }

  this._setTimestampVariable();
  if (this.onePagePath) {
    const page = addressablePages.find(p => p.src === this.onePagePath);
    if (!page) {
      return Promise.reject(new Error(`${this.onePagePath} is not specified in the site configuration.`));
    }
    this.pages.push(this.createPage({
      faviconUrl,
      pageSrc: page.src,
      title: page.title,
      layout: page.layout,
      frontmatter: page.frontmatter,
      searchable: page.searchable !== 'no',
      externalScripts: page.externalScripts,
    }));
  } else {
    this.pages = addressablePages.map(page => this.createPage({
      faviconUrl,
      pageSrc: page.src,
      title: page.title,
      layout: page.layout,
      frontmatter: page.frontmatter,
      searchable: page.searchable !== 'no',
      externalScripts: page.externalScripts,
    }));
  }

  const progressBar = new ProgressBar(`[:bar] :current / ${this.pages.length} pages built`,
                                      { total: this.pages.length });
  progressBar.render();
  this.pages.forEach((page) => {
    processingFiles.push(page.generate(builtFiles)
      .then(() => progressBar.tick())
      .catch((err) => {
        logger.error(err);
        return Promise.reject(new Error(`Error while generating ${page.sourcePath}`));
      }));
  });
  return new Promise((resolve, reject) => {
    Promise.all(processingFiles)
      .then(resolve)
      .catch(reject);
  });
};

/**
 * Re-renders pages that contain the original file path
 * as the source file or as a static/dynamic included file
 * @param filePaths array of paths corresponding to files that have changed
 */
Site.prototype.regenerateAffectedPages = function (filePaths) {
  const builtFiles = new Set();
  const processingFiles = [];
  const shouldRebuildAllPages = this.collectUserDefinedVariablesMapIfNeeded(filePaths) || this.forceReload;
  if (shouldRebuildAllPages) {
    logger.warn('Rebuilding all pages as variables file was changed, or the --force-reload flag was set');
  }
  this._setTimestampVariable();
  this.pages.forEach((page) => {
    if (shouldRebuildAllPages || filePaths.some(filePath => page.includedFiles.has(filePath))) {
      // eslint-disable-next-line no-param-reassign
      page.userDefinedVariablesMap = this.userDefinedVariablesMap;
      processingFiles.push(page.generate(builtFiles)
        .catch((err) => {
          logger.error(err);
          return Promise.reject(new Error(`Error while generating ${page.sourcePath}`));
        }));
    }
  });

  logger.info(`Rebuilding ${processingFiles.length} pages`);

  return new Promise((resolve, reject) => {
    Promise.all(processingFiles)
      .then(() => this.updateSiteData(shouldRebuildAllPages ? undefined : filePaths))
      .then(() => logger.info('Pages rebuilt'))
      .then(resolve)
      .catch(reject);
  });
};


/**
 * Uses heading data in built pages to generate heading and keyword information for siteData
 * Subsequently writes to siteData.json
 * @param filePaths optional array of updated file paths during live preview.
 *                  If undefined, generate site data for all pages
 */
Site.prototype.updateSiteData = function (filePaths) {
  const generateForAllPages = filePaths === undefined;
  this.pages.forEach((page) => {
    if (generateForAllPages || filePaths.some(filePath => page.includedFiles.has(filePath))) {
      page.collectHeadingsAndKeywords();
      page.concatenateHeadingsAndKeywords();
    }
  });
  this.writeSiteData();
};

/**
 * Copies Font Awesome assets to the assets folder
 */
Site.prototype.copyFontAwesomeAsset = function () {
  const faRootSrcPath = path.join(__dirname, '..', 'node_modules', '@fortawesome', 'fontawesome-free');
  const faCssSrcPath = path.join(faRootSrcPath, 'css', 'all.min.css');
  const faCssDestPath = path.join(this.siteAssetsDestPath, 'fontawesome', 'css', 'all.min.css');
  const faFontsSrcPath = path.join(faRootSrcPath, 'webfonts');
  const faFontsDestPath = path.join(this.siteAssetsDestPath, 'fontawesome', 'webfonts');

  return fs.copyAsync(faCssSrcPath, faCssDestPath).then(fs.copyAsync(faFontsSrcPath, faFontsDestPath));
};

/**
 * Copies MarkBind assets to the assets folder
 */
Site.prototype.copyMarkBindAsset = function () {
  const maybeOverrideDefaultBootstrapTheme = () => {
    const { theme } = this.siteConfig;
    if (!theme || !_.has(SUPPORTED_THEMES_PATHS, theme)) {
      return _.noop;
    }

    const themeSrcPath = SUPPORTED_THEMES_PATHS[theme];
    const themeDestPath = path.join(this.siteAssetsDestPath, 'css', 'bootstrap.min.css');

    return new Promise((resolve, reject) => {
      fs.copyAsync(themeSrcPath, themeDestPath)
        .then(resolve)
        .catch(reject);
    });
  };

  return fs.copyAsync(this.siteAssetsSrcPath, this.siteAssetsDestPath)
    .then(maybeOverrideDefaultBootstrapTheme);
};

/**
 * Copies layouts to the assets folder
 */
Site.prototype.copyLayouts = function () {
  const siteLayoutPath = path.join(this.rootPath, LAYOUT_FOLDER_PATH);
  const layoutsDestPath = path.join(this.siteAssetsDestPath, LAYOUT_SITE_FOLDER_NAME);
  if (!fs.existsSync(siteLayoutPath)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    fs.copyAsync(siteLayoutPath, layoutsDestPath)
      .then(resolve)
      .catch(reject);
  });
};

/**
 * Writes the site data to a file
 */
Site.prototype.writeSiteData = function () {
  return new Promise((resolve, reject) => {
    const siteDataPath = path.join(this.outputPath, SITE_DATA_NAME);
    const siteData = {
      enableSearch: this.siteConfig.enableSearch,
      pages: this.pages.filter(page => page.searchable)
        .map(page => ({ headings: page.headings, ...page.frontMatter })),
    };

    fs.outputJsonAsync(siteDataPath, siteData)
      .then(() => logger.info('Site data built'))
      .then(resolve)
      .catch((error) => {
        rejectHandler(reject, error, [this.tempPath, this.outputPath]);
      });
  });
};

Site.prototype.deploy = function (travisTokenVar) {
  const defaultDeployConfig = {
    branch: 'gh-pages',
    message: 'Site Update.',
    repo: '',
  };
  process.env.NODE_DEBUG = 'gh-pages';
  return new Promise((resolve, reject) => {
    const publish = Promise.promisify(ghpages.publish);
    this.readSiteConfig()
      .then(() => {
        this.siteConfig.deploy = this.siteConfig.deploy || {};
        const basePath = this.siteConfig.deploy.baseDir || this.outputPath;
        if (!fs.existsSync(basePath)) {
          reject(new Error('The site directory does not exist. Please build the site first before deploy.'));
          return undefined;
        }
        const options = {};
        options.branch = this.siteConfig.deploy.branch || defaultDeployConfig.branch;
        options.message = this.siteConfig.deploy.message || defaultDeployConfig.message;
        options.repo = this.siteConfig.deploy.repo || defaultDeployConfig.repo;

        if (travisTokenVar) {
          if (!process.env.TRAVIS) {
            reject(new Error('-t/--travis should only be run in Travis CI.'));
            return undefined;
          }
          // eslint-disable-next-line no-param-reassign
          travisTokenVar = _.isBoolean(travisTokenVar) ? 'GITHUB_TOKEN' : travisTokenVar;
          if (!process.env[travisTokenVar]) {
            reject(new Error(`The environment variable ${travisTokenVar} does not exist.`));
            return undefined;
          }

          const githubToken = process.env[travisTokenVar];
          let repoSlug = process.env.TRAVIS_REPO_SLUG;
          if (options.repo) {
            // Extract repo slug from user-specified repo URL so that we can include the access token
            const repoSlugRegex = /github\.com[:/]([\w-]+\/[\w-.]+)\.git$/;
            const repoSlugMatch = repoSlugRegex.exec(options.repo);
            if (!repoSlugMatch) {
              reject(new Error('-t/--travis expects a GitHub repository.\n'
                + `The specified repository ${options.repo} is not valid.`));
              return undefined;
            }
            [, repoSlug] = repoSlugMatch;
          }
          options.repo = `https://${githubToken}@github.com/${repoSlug}.git`;
          options.user = {
            name: 'Deployment Bot',
            email: 'deploy@travis-ci.org',
          };
        }

        return publish(basePath, options);
      })
      .then(resolve)
      .catch(reject);
  });
};

Site.prototype._setTimestampVariable = function () {
  const time = new Date().toUTCString();
  Object.keys(this.userDefinedVariablesMap).forEach((base) => {
    this.userDefinedVariablesMap[base].timestamp = time;
  });
  return Promise.resolve();
};

module.exports = Site;
