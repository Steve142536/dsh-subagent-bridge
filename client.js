/**
 * @local/dsh-subagent-bridge — client.js
 *
 * DSH Web UI 插件面板：展示当前正在运行（以及最近的）DSH 子代理任务。
 * 数据来自 Host 在内置 HTTP 服务上暴露的 /mcp/dsh-subagent/tasks（按创建时间倒序）。
 *
 * 结构：window.__ModuleLoader__.load → factory(require) → { inject, apply }。
 * 仅依赖宿主模块表提供的 react；不引第三方依赖，不 require 任何宿主 UI 组件包。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-subagent-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /* ============================== 常量 ============================== */

    // 宿主面板体系：sidebar.panellist 的图标条目 id 与 main 的面板 key 相同，
    // 侧栏自动生成按钮并 dispatch 对应 main 面板（官方 plugins/schedules 同款模式）。
    const ICON_SLOT = 'sidebar.panellist';
    const PANEL_SLOT = 'main';
    const PANEL_KEY = 'dsh-subagent-bridge';
    const PLUGIN_PACKAGE = '@local/dsh-subagent-bridge'; // bundle 详情页配置 slot 的 key = 包名
    const PLUGIN_CONFIG_SLOT = 'plugins.bundle.config';
    const LOCALE_NS = '@local/dsh-subagent-bridge'; // locale 词典命名空间，与插件 id 一致
    const TASKS_URL = '/mcp/dsh-subagent/tasks';
    const INFO_URL = '/mcp/dsh-subagent/info';
    const CONFIG_URL = '/mcp/dsh-subagent/config'; // 子代理模型配置读写（Host 路由）
    const POLL_INTERVAL_MS = 2500; // 轮询间隔
    const MAX_HISTORY = 20;        // 主面板最多展示的最近已完成/失败任务数

    // 主题 token 均已核实（依据 @deepseek-ai/dsh-client-ui-theme 编译产物中的
    // ThemeRuntime.BUILTIN_INSPECT_TOKENS —— 它正是 client inspect Theme.listTokens
    // 的数据源；client inspect 查询当时超时，改用源码等价验证）。
    // 全部颜色走 token，不写死十六进制色值；未知状态回退 idle 色。
    const COLOR_QUEUED = 'var(--dsw-alias-state-idle-primary)';
    const COLOR_RUNNING = 'var(--dsw-alias-brand-primary)';
    const COLOR_COMPLETED = 'var(--dsw-alias-state-success-primary)';
    const COLOR_FAILED = 'var(--dsw-alias-state-error-primary)';

    /* ============================ 小工具函数 ============================ */

    function statusColor(status) {
      if (status === 'running') return COLOR_RUNNING;
      if (status === 'completed') return COLOR_COMPLETED;
      if (status === 'failed') return COLOR_FAILED;
      return COLOR_QUEUED;
    }

    function statusTextKey(status) {
      if (status === 'running') return 'statusRunning';
      if (status === 'completed') return 'statusCompleted';
      if (status === 'failed') return 'statusFailed';
      return 'statusQueued';
    }

    // 运行中（含排队）判定：状态条计数与卡片分组都用它。
    function isActive(status) {
      return status === 'queued' || status === 'running';
    }

    // 耗时格式化："12s" / "3m05s"；不足 1 秒记 "0s"；不引入小时单位保持紧凑。
    function formatDuration(ms) {
      const total = typeof ms === 'number' && isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      if (minutes > 0) return minutes + 'm' + String(seconds).padStart(2, '0') + 's';
      return seconds + 's';
    }

    // ISO 时间 → 本地时分秒（详情时间线用；历史任务多为当天，日期场景再扩展）。
    // 无效输入原样返回，避免显示 "Invalid Date"。
    function formatTime(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return safeText(iso);
      return d.toLocaleTimeString();
    }

    // 字段安全转字符串：TaskView 字段可能为 null。
    function safeText(value) {
      if (typeof value === 'string') return value;
      if (value == null) return '';
      return String(value);
    }

    // "{count}" 占位符替换（回退 t 使用；宿主 locale 的 t 原生支持同语法）。
    function interpolate(template, params) {
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, function (match, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
      });
    }

    // 诊断用：当前页面 origin（file:// 等非 http 环境原样显示，用于定位
    // "相对路径 fetch 在桌面窗口里到不了 Host HTTP 服务"这类环境差异）。
    function safeOrigin() {
      try {
        return String(window.location && window.location.origin);
      } catch (error) {
        return 'unknown';
      }
    }

    /* ============================ 文案词典 ============================ */
    // key 集合与 Host 侧 locale 文件约定一致（含暂无 UI 使用点的 unreachable，
    // 保持两份词典对齐）；en 版为对应英文。
    const DICTS = {
      zh: {
        title: 'DSH 子代理',
        runningOne: '1 个子代理运行中',
        runningMany: '{count} 个子代理运行中',
        idle: '没有运行中的子代理',
        empty: '暂无任务。从 Codex 通过 MCP 委托任务后，这里会显示进度。',
        expand: '展开任务',
        collapse: '收起任务',
        statusQueued: '排队中',
        statusRunning: '运行中',
        statusCompleted: '已完成',
        statusFailed: '失败',
        connectTitle: '在 Codex 中把 DSH 当作子代理使用',
        showGuide: '展开使用说明',
        hideGuide: '收起使用说明',
        usageTitle: '如何使用',
        usageStep1: '① 接入 Codex：把下面的提示词发给 DSH 助手，它会完成 MCP 注册，并把使用规则写进 Codex 系统提示词（~/.codex/AGENTS.md）。',
        usageStep2: '② 新开 Codex 会话直接说需求：所有任务由 DSH 子代理执行，Codex 主代理负责拆解、检查和验收。',
        usageStep3: '③ 本面板实时显示子代理运行状态，点击卡片查看详情（任务全文、结果、错误）。',
        installTitle: '第一步操作：复制提示词发给 DSH 助手',
        installHint: '提示词已自动嵌入当前桥接地址，助手会按步骤代办：',
        installPrompt: '请把 DSH 子代理桥接接入 Codex，端点：{url}\n一、注册 MCP 服务器：优先运行 codex mcp add dsh-subagent --url {url}；若 codex 不在 PATH，用桌面端自带 CLI（%LOCALAPPDATA%\\OpenAI\\Codex\\bin\\<版本号>\\codex.exe）执行同样命令；仍不行则直接编辑 ~/.codex/config.toml 追加以下两行：\n[mcp_servers.dsh-subagent]\nurl = "{url}"\n完成后用 codex mcp get dsh-subagent 验证 enabled: true。\n二、在 ~/.codex/AGENTS.md 末尾追加以下使用规则（文件不存在则创建）：\n## DSH 子代理使用规则\n- 所有任务请使用 DSH 子代理，主代理负责检查和验收。\n- 子代理没有生成图片的能力，所有生成图像的能力交给主代理（生成图像的任务由主代理自己完成）。\n- 委托时把任务描述写全（文件路径、上下文、验收标准写进 task）；验收不通过时给出具体修改意见，再次委托子代理修改。\n三、两步完成后告知用户：新开 Codex 会话即可使用。',
        connectHint: '备选：手动在 Codex 终端执行注册命令：',
        copy: '复制',
        copied: '已复制',
        copyFailed: '复制失败',
        resultLabel: '结果',
        errorLabel: '错误',
        sessionLabel: '会话',
        labelTask: '任务',
        labelCreated: '创建',
        labelStarted: '开始',
        labelEnded: '结束',
        labelElapsed: '耗时',
        labelPid: '进程',
        labelCwd: '目录',
        configTitle: '子代理模型',
        configFollow: '跟随 DSH 默认模型',
        configPlaceholder: 'provider/model，例如 glm/glm-5.3-flash',
        configHint: '留空时子代理使用 DSH 当前默认模型；选择后由桥接在启动 headless 子代理时覆盖默认模型。',
        configSave: '保存',
        configSaved: '已保存',
        configError: '保存失败，请重试',
        unreachable: '桥接不可用',
      },
      en: {
        title: 'DSH Subagents',
        runningOne: '1 subagent running',
        runningMany: '{count} subagents running',
        idle: 'No running subagents',
        empty: 'No tasks yet. Delegate tasks from Codex via MCP and progress will show up here.',
        expand: 'Show tasks',
        collapse: 'Hide tasks',
        statusQueued: 'Queued',
        statusRunning: 'Running',
        statusCompleted: 'Completed',
        statusFailed: 'Failed',
        connectTitle: 'Use DSH as a subagent in Codex',
        showGuide: 'Show usage guide',
        hideGuide: 'Hide usage guide',
        usageTitle: 'How to use',
        usageStep1: '1. Connect Codex: send the prompt below to the DSH assistant; it registers the MCP server and adds the usage rules to the Codex instructions (~/.codex/AGENTS.md).',
        usageStep2: '2. Open a new Codex session and state your task: all tasks run via DSH subagents while the Codex main agent decomposes, checks, and accepts.',
        usageStep3: '3. This panel shows subagent status in real time; click a card for details (full task, result, errors).',
        installTitle: 'Step one: copy the prompt and send it to the DSH assistant',
        installHint: 'The current bridge URL is already embedded; the assistant handles the rest:',
        installPrompt: 'Please wire the DSH subagent bridge into Codex, endpoint: {url}\n1. Register the MCP server: run codex mcp add dsh-subagent --url {url}; if codex is not on PATH, use the desktop-bundled CLI (%LOCALAPPDATA%\\OpenAI\\Codex\\bin\\<version>\\codex.exe) with the same command; otherwise edit ~/.codex/config.toml and append:\n[mcp_servers.dsh-subagent]\nurl = "{url}"\nVerify with codex mcp get dsh-subagent (enabled: true).\n2. Append the following usage rules to ~/.codex/AGENTS.md (create the file if missing):\n## DSH subagent usage rules\n- Use DSH subagents for all tasks; the main agent checks and accepts the results.\n- Subagents cannot generate images: all image generation stays with the main agent.\n- Write self-contained task descriptions (paths, context, acceptance criteria in task); on rejection, give concrete revision notes and delegate again.\n3. When both steps are done, tell the user a new Codex session picks it up.',
        connectHint: 'Fallback: run the registration command in a Codex terminal:',
        copy: 'Copy',
        copied: 'Copied',
        copyFailed: 'Copy failed',
        resultLabel: 'Result',
        errorLabel: 'Error',
        sessionLabel: 'Session',
        labelTask: 'Task',
        labelCreated: 'Created',
        labelStarted: 'Started',
        labelEnded: 'Ended',
        labelElapsed: 'Elapsed',
        labelPid: 'PID',
        labelCwd: 'Dir',
        configTitle: 'Subagent model',
        configFollow: 'Follow the DSH default model',
        configPlaceholder: 'provider/model, e.g. glm/glm-5.3-flash',
        configHint: 'Leave empty to use the DSH default model; a custom choice overrides the default model when launching headless subagents.',
        configSave: 'Save',
        configSaved: 'Saved',
        configError: 'Save failed, please retry',
        unreachable: 'Bridge unavailable',
      },
    };

    /* =========================== locale 接入 =========================== */
    // 结论（已核实 @deepseek-ai/dsh-client-locale 的 client 契约，与官方
    // dsh-client-ui-theme 的用法一致）：
    //   1. locale 插件在 client ctx 上 provide 了名为 "locale" 的服务，
    //      因此本插件通过 inject: ['slots', 'locale'] 声明服务依赖；
    //   2. 插件文案必须自注册词典：ctx.locale.register(ns, { zh, en })，
    //      它返回 disposer，用 ctx.effect 挂载即可随插件卸载自动注销；
    //   3. ctx.locale.bind(ns) 返回 t(key, params)，支持 "{count}" 占位符，
    //      每次调用实时查询当前语言，语言切换后的下一次渲染即生效；
    //   4. locale 快照经 getSnapshot/subscribe（LocaleFace）暴露，
    //      用 React.useSyncExternalStore 订阅，语言切换时触发重渲染；
    //   5. 若 locale 服务不可用（理论上不会，它是内置 immediately 插件），
    //      回退为按 navigator.language 选择静态 zh/en 词典（下方 fallback）。

    function createFallbackLocale() {
      // 回退方案：无 locale 服务时按浏览器语言选静态词典，无订阅能力。
      let lang = 'en';
      try {
        lang = String((typeof navigator !== 'undefined' && navigator.language) || 'en');
      } catch (error) { /* 忽略，保持 en */ }
      const dict = DICTS[lang.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'];
      return {
        t(key, params) { return interpolate(dict[key] != null ? dict[key] : key, params); },
        subscribe: null,
        getSnapshot: null,
      };
    }

    // 渲染期随时可用的 locale 句柄；apply() 成功接入宿主服务后覆盖回退实现。
    let localeApi = createFallbackLocale();

    const noopSubscribe = function () { return function () {}; };
    const nullSnapshot = function () { return null; };
    // React 18 提供 useSyncExternalStore；缺失时退化为 no-op hook（调用顺序
    // 在组件生命周期内保持一致），语言切换后的刷新依赖轮询数据带来的重渲染。
    const useStoreOrNoop = typeof React.useSyncExternalStore === 'function'
      ? React.useSyncExternalStore
      : function () { return null; };

    function setupLocale(ctx) {
      const locale = ctx.locale;
      if (!locale || typeof locale.register !== 'function' || typeof locale.bind !== 'function') return;
      try {
        // 词典注册跟随插件生命周期：ctx.effect 的工厂返回 disposer 即自动清理。
        // 用单 locale 的 untyped register 形式（契约明确支持表外 ns 与任意
        // locale 集合），避免 typed 批量形式"必须提供全部内置 locale"的
        // 运行时校验限制；zh/en 两个 tag 均为合法 BCP 47 主标签。
        ctx.effect(function () {
          const disposeZh = locale.register(LOCALE_NS, 'zh', DICTS.zh);
          const disposeEn = locale.register(LOCALE_NS, 'en', DICTS.en);
          return function () { disposeZh(); disposeEn(); };
        }, 'dsh-subagent-bridge: locale dictionaries');
        localeApi = {
          t: locale.bind(LOCALE_NS),
          subscribe: typeof locale.subscribe === 'function' ? locale.subscribe.bind(locale) : null,
          getSnapshot: typeof locale.getSnapshot === 'function' ? locale.getSnapshot.bind(locale) : null,
        };
      } catch (error) {
        // 注册失败不致命：保留回退实现，仅提示不抛错。
        console.warn('[dsh-subagent-bridge] locale 服务不可用，回退到 navigator.language 方案');
      }
    }

    /* ============================== 样式 ============================== */
    // 样式集中在组件内 <style>（随组件卸载自动移除），类名统一前缀。
    // 颜色/边框/背景只用已核实的 --dsw-alias-* token；圆角为尺寸值非颜色。
    const CSS = [
      // 主区面板页面：占满 main 面板列，自带滚动
      '.dsh-subagent-bridge-page{height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:16px 20px;overflow-y:auto;font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.dsh-subagent-bridge-page-head{display:flex;align-items:center;gap:8px;flex:none}',
      '.dsh-subagent-bridge-page-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      // 标题旁的运行中计数徽标：品牌色点 + "N 个子代理运行中"
      '.dsh-subagent-bridge-page-count{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:10px;font-size:11px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-brand-primary)}',
      '.dsh-subagent-bridge-page-count-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-brand-primary);animation:dsh-subagent-bridge-pulse 1.6s ease-in-out infinite}',
      '@keyframes dsh-subagent-bridge-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.7)}}',
      // 任务列表容器：限宽保持可读，左对齐
      '.dsh-subagent-bridge-page-list{display:flex;flex-direction:column;gap:6px;max-width:760px}',
      '.dsh-subagent-bridge-empty{padding:6px 8px}',
      // 数据通道诊断块：小号等宽文本，显示 origin 与错误消息
      '.dsh-subagent-bridge-diag{margin-top:3px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;opacity:.8;word-break:break-all;white-space:pre-wrap}',
      // 任务卡片
      '.dsh-subagent-bridge-card{display:flex;flex-direction:column;gap:3px;padding:6px 8px;font:inherit;font-size:12px;text-align:left;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px}',
      '.dsh-subagent-bridge-card-clickable{cursor:pointer}',
      '.dsh-subagent-bridge-card-clickable:hover{border-color:var(--dsw-alias-border-l2)}',
      '.dsh-subagent-bridge-card-head{display:flex;align-items:center;gap:6px}',
      '.dsh-subagent-bridge-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px}',
      '.dsh-subagent-bridge-badge-dot{width:6px;height:6px;border-radius:50%;flex:none}',
      '.dsh-subagent-bridge-duration{margin-left:auto;flex:none;font-size:11px;opacity:.85;font-variant-numeric:tabular-nums}',
      '.dsh-subagent-bridge-task-text{color:var(--dsw-alias-label-primary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}',
      // 展开箭头：跟在耗时后面，提示整卡可点
      '.dsh-subagent-bridge-chevron{flex:none;font-size:10px;opacity:.6}',
      // 点击展开的详情区：meta 键值行 + 分节全文块（任务/结果/错误）
      '.dsh-subagent-bridge-detail-body{display:flex;flex-direction:column;gap:5px;margin-top:2px;padding-top:5px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dsh-subagent-bridge-detail-label{font-size:11px;opacity:.9}',
      '.dsh-subagent-bridge-meta{display:flex;flex-wrap:wrap;gap:2px 14px}',
      '.dsh-subagent-bridge-meta-item{font-size:11px;min-width:0}',
      '.dsh-subagent-bridge-meta-label{opacity:.6;margin-right:4px}',
      '.dsh-subagent-bridge-meta-value{opacity:.95;word-break:break-all}',
      '.dsh-subagent-bridge-full{display:flex;flex-direction:column;gap:2px;min-width:0}',
      // 全文块：左侧竖线标识引用区；超高滚动，避免超长结果撑爆面板
      '.dsh-subagent-bridge-full-text{font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:260px;overflow-y:auto;padding-left:6px;border-left:2px solid var(--dsw-alias-border-l2)}',
      '.dsh-subagent-bridge-detail-failed{color:var(--dsw-alias-state-error-primary)}',
      // Codex 接入指引（空状态）
      // 使用指引容器（页面顶部）：折叠态仅标题行，展开态含三步与复制块
      '.dsh-subagent-bridge-connect{display:flex;flex-direction:column;gap:4px;padding:8px;background:var(--dsw-alias-bg-layer-2);border:1px dashed var(--dsw-alias-border-l2);border-radius:6px}',
      '.dsh-subagent-bridge-connect-toggle{display:flex;align-items:center;gap:6px;padding:0;margin:0;font:inherit;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);background:transparent;border:none;cursor:pointer;text-align:left}',
      '.dsh-subagent-bridge-connect-folded{padding:4px 8px}',
      '.dsh-subagent-bridge-connect-hint{font-size:11px}',
      '.dsh-subagent-bridge-command-row{display:flex;align-items:center;gap:6px;margin-top:2px}',
      '.dsh-subagent-bridge-command{flex:1 1 auto;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;padding:4px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
      // "让 DSH 助手安装"分节：小标题 + 多行提示词块（等宽、可滚动）+ 复制按钮
      '.dsh-subagent-bridge-connect-sub{margin-top:2px;color:var(--dsw-alias-label-primary)}',
      '.dsh-subagent-bridge-prompt-row{display:flex;align-items:flex-start;gap:6px}',
      '.dsh-subagent-bridge-prompt{flex:1 1 auto;min-width:0;max-height:180px;overflow-y:auto;margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;padding:6px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;color:var(--dsw-alias-label-primary)}',
      '.dsh-subagent-bridge-copy{flex:none;font:inherit;font-size:11px;padding:3px 8px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dsh-subagent-bridge-copy:hover{color:var(--dsw-alias-label-primary)}',
      // 设置表单（bundle 详情页）：标题 + 下拉/手填 + 保存反馈
      '.dsh-subagent-bridge-cfg{display:flex;flex-direction:column;gap:8px;padding:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;max-width:560px}',
      '.dsh-subagent-bridge-cfg-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsh-subagent-bridge-cfg-row{display:flex;align-items:center;gap:8px}',
      '.dsh-subagent-bridge-cfg-input{flex:1 1 auto;min-width:0;font:inherit;font-size:12px;padding:4px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.dsh-subagent-bridge-cfg-hint{font-size:11px;opacity:.8}',
      '.dsh-subagent-bridge-cfg-saved{font-size:11px;color:var(--dsw-alias-state-success-primary)}',
    ].join('');

    /* ============================== 组件 ============================== */

    // 任务卡片：任何状态都可点击展开详情——meta 键值行（创建/开始/结束/耗时/
    // 进程/目录/会话，只展示有值的字段）+ 任务全文 + 结果/错误全文。整卡 button
    // 语义（role=button + Enter/Space），箭头指示展开状态。
    function TaskCard({ task, t }) {
      const [open, setOpen] = React.useState(false);
      const status = safeText(task.status);
      const isCompleted = status === 'completed';
      const isFailed = status === 'failed';
      const answer = isCompleted ? safeText(task.answer) : '';
      const error = isFailed ? safeText(task.error) : '';
      const sessionId = task.sessionId == null ? '' : safeText(task.sessionId);
      const cwd = safeText(task.cwd);
      const taskText = safeText(task.task);

      const children = [
        h('div', { key: 'head', className: 'dsh-subagent-bridge-card-head' },
          h('span', { className: 'dsh-subagent-bridge-badge' },
            h('span', {
              'aria-hidden': true,
              className: 'dsh-subagent-bridge-badge-dot',
              style: { backgroundColor: statusColor(status) },
            }),
            t(statusTextKey(status)),
          ),
          h('span', { className: 'dsh-subagent-bridge-duration' }, formatDuration(task.elapsedMs)),
          h('span', { 'aria-hidden': true, className: 'dsh-subagent-bridge-chevron' }, open ? '▾' : '▸'),
        ),
        h('div', {
          key: 'text',
          className: 'dsh-subagent-bridge-task-text',
          title: taskText, // 悬停给全文
        }, taskText),
      ];

      if (open) {
        // 键值行：逐项判断，空字段不渲染，避免一排空标签
        const metaItems = [
          h('span', { key: 'created', className: 'dsh-subagent-bridge-meta-item' },
            h('span', { className: 'dsh-subagent-bridge-meta-label' }, t('labelCreated')),
            h('span', { className: 'dsh-subagent-bridge-meta-value' }, formatTime(task.createdAt)),
          ),
        ];
        if (task.startedAt) {
          metaItems.push(h('span', { key: 'started', className: 'dsh-subagent-bridge-meta-item' },
            h('span', { className: 'dsh-subagent-bridge-meta-label' }, t('labelStarted')),
            h('span', { className: 'dsh-subagent-bridge-meta-value' }, formatTime(task.startedAt)),
          ));
        }
        if (task.endedAt) {
          metaItems.push(h('span', { key: 'ended', className: 'dsh-subagent-bridge-meta-item' },
            h('span', { className: 'dsh-subagent-bridge-meta-label' }, t('labelEnded')),
            h('span', { className: 'dsh-subagent-bridge-meta-value' }, formatTime(task.endedAt)),
          ));
        }
        metaItems.push(h('span', { key: 'elapsed', className: 'dsh-subagent-bridge-meta-item' },
          h('span', { className: 'dsh-subagent-bridge-meta-label' }, t('labelElapsed')),
          h('span', { className: 'dsh-subagent-bridge-meta-value' }, formatDuration(task.elapsedMs)),
        ));
        if (task.pid != null) {
          metaItems.push(h('span', { key: 'pid', className: 'dsh-subagent-bridge-meta-item' },
            h('span', { className: 'dsh-subagent-bridge-meta-label' }, t('labelPid')),
            h('span', { className: 'dsh-subagent-bridge-meta-value' }, String(task.pid)),
          ));
        }
        if (cwd) {
          metaItems.push(h('span', { key: 'cwd', className: 'dsh-subagent-bridge-meta-item', title: cwd },
            h('span', { className: 'dsh-subagent-bridge-meta-label' }, t('labelCwd')),
            h('span', { className: 'dsh-subagent-bridge-meta-value' }, cwd),
          ));
        }
        if (sessionId) {
          metaItems.push(h('span', { key: 'session', className: 'dsh-subagent-bridge-meta-item', title: sessionId },
            h('span', { className: 'dsh-subagent-bridge-meta-label' }, t('sessionLabel')),
            h('span', { className: 'dsh-subagent-bridge-meta-value' }, sessionId),
          ));
        }

        children.push(h('div', { key: 'detail', className: 'dsh-subagent-bridge-detail-body' },
          h('div', { key: 'meta', className: 'dsh-subagent-bridge-meta' }, metaItems),
          h('div', { key: 'taskfull', className: 'dsh-subagent-bridge-full' },
            h('div', { className: 'dsh-subagent-bridge-detail-label' }, t('labelTask')),
            h('div', { className: 'dsh-subagent-bridge-full-text' }, taskText),
          ),
          answer ? h('div', { key: 'answer', className: 'dsh-subagent-bridge-full' },
            h('div', { className: 'dsh-subagent-bridge-detail-label' }, t('resultLabel')),
            h('div', { className: 'dsh-subagent-bridge-full-text' }, answer),
          ) : null,
          error ? h('div', { key: 'error', className: 'dsh-subagent-bridge-full' },
            h('div', { className: 'dsh-subagent-bridge-detail-label' }, t('errorLabel')),
            h('div', {
              className: 'dsh-subagent-bridge-full-text dsh-subagent-bridge-detail-failed',
            }, error),
          ) : null,
        ));
      }

      return h('div', {
        className: 'dsh-subagent-bridge-card dsh-subagent-bridge-card-clickable',
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open,
        onClick: function () { setOpen(!open); },
        onKeyDown: function (event) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(!open);
          }
        },
      }, children);
    }

    // 使用指引（页面顶部，可折叠）：默认"无运行任务时展开、有任务时折叠"，
    // 由 PanelMain 通过 open/onToggle 控制；标题行始终可点。
    // info 不可达时仍渲染标题与三步说明，仅省略依赖 mcpUrl 的复制块。
    // 复制成功 2 秒后回弹为"复制"。
    function ConnectHint({ t, open, onToggle }) {
      const [mcpUrl, setMcpUrl] = React.useState('');
      const [copyStates, setCopyStates] = React.useState({ cmd: 'copy', prompt: 'copy' });
      const timerRef = React.useRef({});

      React.useEffect(function () {
        let alive = true;
        const controller = new AbortController();
        fetch(INFO_URL, { signal: controller.signal })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (data) {
            if (alive && data && typeof data.mcpUrl === 'string' && data.mcpUrl) {
              setMcpUrl(data.mcpUrl);
            }
          })
          .catch(function () { /* info 拿不到就只显示说明文字，保持安静 */ });
        return function () {
          alive = false;
          controller.abort();
          Object.keys(timerRef.current).forEach(function (key) {
            if (timerRef.current[key]) clearTimeout(timerRef.current[key]);
          });
          timerRef.current = {};
        };
      }, []);

      const command = mcpUrl ? 'codex mcp add dsh-subagent --url ' + mcpUrl : '';
      const prompt = mcpUrl ? interpolate(safeText(t('installPrompt')), { url: mcpUrl }) : '';

      function setCopyState(which, value) {
        setCopyStates(function (prev) {
          const next = Object.assign({}, prev);
          next[which] = value;
          return next;
        });
      }

      function handleCopy(text, which) {
        const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
        if (!clipboard || typeof clipboard.writeText !== 'function') {
          setCopyState(which, 'copyFailed');
          return;
        }
        clipboard.writeText(text).then(function () {
          setCopyState(which, 'copied');
          if (timerRef.current[which]) clearTimeout(timerRef.current[which]);
          timerRef.current[which] = setTimeout(function () {
            setCopyState(which, 'copy');
          }, 2000);
        }, function () {
          setCopyState(which, 'copyFailed');
        });
      }

      function copyButton(text, which) {
        const state = copyStates[which] || 'copy';
        return h('button', {
          type: 'button',
          className: 'dsh-subagent-bridge-copy',
          onClick: function () { handleCopy(text, which); },
        }, state === 'copied' ? t('copied') : state === 'copyFailed' ? t('copyFailed') : t('copy'));
      }

      // 折叠/展开共用标题行：箭头 + 标题，整行可点
      const titleRow = h('button', {
        type: 'button',
        className: 'dsh-subagent-bridge-connect-toggle',
        'aria-expanded': open,
        title: open ? t('hideGuide') : t('showGuide'),
        onClick: onToggle,
      },
        h('span', { 'aria-hidden': true, className: 'dsh-subagent-bridge-chevron' }, open ? '▾' : '▸'),
        t('connectTitle'),
      );

      if (!open) {
        return h('div', {
          className: 'dsh-subagent-bridge-connect dsh-subagent-bridge-connect-folded',
        }, titleRow);
      }

      const body = [
        // 使用流程三步概览
        h('div', { key: 'usage-title', className: 'dsh-subagent-bridge-connect-sub' }, t('usageTitle')),
        h('div', { key: 'step1', className: 'dsh-subagent-bridge-connect-hint' }, t('usageStep1')),
        h('div', { key: 'step2', className: 'dsh-subagent-bridge-connect-hint' }, t('usageStep2')),
        h('div', { key: 'step3', className: 'dsh-subagent-bridge-connect-hint' }, t('usageStep3')),
      ];
      if (mcpUrl) {
        body.push(
          // 第一步操作：整段提示词一键复制（自动嵌入当前 mcpUrl），DSH 助手代办
          h('div', { key: 'install-title', className: 'dsh-subagent-bridge-connect-sub' }, t('installTitle')),
          h('div', { key: 'install-hint', className: 'dsh-subagent-bridge-connect-hint' }, t('installHint')),
          h('div', { key: 'prompt-row', className: 'dsh-subagent-bridge-prompt-row' },
            h('pre', { className: 'dsh-subagent-bridge-prompt' }, prompt),
            copyButton(prompt, 'prompt'),
          ),
          // 备选：手动在 Codex 终端执行注册命令
          h('div', { key: 'cmd-hint', className: 'dsh-subagent-bridge-connect-hint' }, t('connectHint')),
          h('div', { key: 'cmd-row', className: 'dsh-subagent-bridge-command-row' },
            h('code', { className: 'dsh-subagent-bridge-command', title: command }, command),
            copyButton(command, 'cmd'),
          ),
        );
      }
      return h('div', { className: 'dsh-subagent-bridge-connect' }, titleRow, body);
    }

    // 数据轮询 hook：2500ms 轮询 /tasks，页面不可见时暂停，恢复可见立即补一次。
    // 数据通道失败时保留诊断信息（origin + 错误），面板绝不静默消失——
    // 否则无法区分"没渲染"和"没数据"。
    function useBridgeTasks() {
      const [state, setState] = React.useState({ reachable: false, tasks: null, error: null });

      React.useEffect(function () {
        let alive = true;
        let controller = null;
        const poll = function () {
          // 页面不可见时不请求，省流量；恢复可见时立即补一次。
          if (document.visibilityState !== 'visible') return;
          controller = new AbortController();
          fetch(TASKS_URL, { signal: controller.signal })
            .then(function (res) {
              if (!res.ok) throw new Error('HTTP ' + res.status);
              return res.json();
            })
            .then(function (data) {
              if (!alive) return;
              const tasks = data && Array.isArray(data.tasks) ? data.tasks : [];
              setState({ reachable: true, tasks: tasks, error: null });
            })
            .catch(function (err) {
              // 卸载引发的 abort 不改变状态；真实失败时保留诊断信息用于面板展示
              if (alive && !(controller && controller.signal.aborted)) {
                setState({
                  reachable: false,
                  tasks: null,
                  error: err && err.message ? String(err.message) : String(err),
                });
              }
            });
        };
        poll();
        const timer = setInterval(poll, POLL_INTERVAL_MS);
        const onVisibility = function () {
          if (document.visibilityState === 'visible') poll();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return function () {
          alive = false;
          clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisibility);
          if (controller) controller.abort();
        };
      }, []); // 仅挂载时建立轮询；setState 引用稳定，无额外依赖

      return state;
    }

    // 任务列表渲染（诊断 / 运行中 / 最近历史 / 空态 + 指引），供主面板使用。
    function taskListChildren(state, t) {
      const children = [];
      if (!state.reachable) {
        children.push(h('div', { key: 'unreachable', className: 'dsh-subagent-bridge-empty' },
          t('unreachable'),
          h('div', { className: 'dsh-subagent-bridge-diag' },
            'origin: ' + safeOrigin(),
            state.error ? 'error: ' + state.error : null,
          ),
        ));
        return children;
      }
      const tasks = Array.isArray(state.tasks) ? state.tasks : [];
      // Host 保证按创建时间倒序，过滤后天然"新的在上"，此处不重复排序。
      const running = tasks.filter(function (task) {
        return isActive(safeText(task.status));
      });
      const history = tasks.filter(function (task) {
        const status = safeText(task.status);
        return status === 'completed' || status === 'failed';
      }).slice(0, MAX_HISTORY);

      // key 优先用任务 id；id 缺失时用索引兜底，避免 React 的 key 警告。
      running.forEach(function (task, index) {
        children.push(h(TaskCard, { key: safeText(task.id) || 'run-' + index, task: task, t: t }));
      });
      history.forEach(function (task, index) {
        children.push(h(TaskCard, { key: safeText(task.id) || 'his-' + index, task: task, t: t }));
      });
      if (children.length === 0) {
        children.push(h('div', { key: 'empty', className: 'dsh-subagent-bridge-empty' }, t('empty')));
      }
      return children;
    }

    // 主区面板：挂载在 main（key = PANEL_KEY），由侧栏图标条目 dispatch 打开。
    function PanelMain() {
      const state = useBridgeTasks();
      const t = localeApi.t;

      // 订阅 locale 快照：语言切换（revision 变化）触发重渲染，t 输出新语言。
      useStoreOrNoop(localeApi.subscribe || noopSubscribe, localeApi.getSnapshot || nullSnapshot);

      const running = state.reachable && Array.isArray(state.tasks)
        ? state.tasks.filter(function (task) { return isActive(safeText(task.status)); })
        : [];

      // 使用指引折叠状态：默认"无运行任务时展开、有任务时折叠"；
      // 用户手动切换一次后保持其选择，直到任务有无状态变化时恢复自动。
      const noRunning = running.length === 0;
      const [guidePinned, setGuidePinned] = React.useState(null);
      React.useEffect(function () { setGuidePinned(null); }, [noRunning]);
      const guideOpen = guidePinned !== null ? guidePinned : noRunning;

      const countLabel = running.length === 1
        ? t('runningOne')
        // t 若已原生替换 {count} 则 interpolate 无操作；否则在此兜底替换
        : interpolate(safeText(t('runningMany', { count: running.length })), { count: running.length });

      return h('div', { className: 'dsh-subagent-bridge-page' },
        h('style', null, CSS),
        h('div', { className: 'dsh-subagent-bridge-page-head' },
          h('h2', { className: 'dsh-subagent-bridge-page-title' }, t('title')),
          state.reachable && running.length > 0
            ? h('span', { className: 'dsh-subagent-bridge-page-count' },
                h('span', { 'aria-hidden': true, className: 'dsh-subagent-bridge-page-count-dot' }),
                countLabel)
            : null,
        ),
        // 使用指引在顶部：无任务时展开，有任务时折叠，标题行可点击切换
        h(ConnectHint, {
          key: 'guide',
          t: t,
          open: guideOpen,
          onToggle: function () { setGuidePinned(!guideOpen); },
        }),
        h('div', { className: 'dsh-subagent-bridge-page-list', role: 'list', 'aria-label': t('title') },
          taskListChildren(state, t),
        ),
      );
    }

    // 侧栏入口图标：对话气泡 + 委托箭头（图形改编自 MIT 许可的 Feather Icons
    // message-circle，允许再分发）。颜色走 currentColor，宿主按钮负责高亮。
    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 20;
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block' },
      },
      h('path', {
        d: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z',
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }),
      h('path', {
        d: 'M9 11h6m-2.5-2.5L15 11l-2.5 2.5',
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }),
      );
    }

    /* ==================== 设置：子代理模型（bundle 详情页） ==================== */

    // bundle 详情页的配置表单：读取/保存"子代理模型"覆盖（provider/model 或空）。
    // view='summary' 渲染列表页一行简述；view='page' 渲染完整表单。
    // 数据走 Host 的 /config 路由；可用模型列表由 Host 从宿主用户 patch 解析。
    function AgentModelConfig({ view }) {
      const t = localeApi.t;
      useStoreOrNoop(localeApi.subscribe || noopSubscribe, localeApi.getSnapshot || nullSnapshot);

      const [loaded, setLoaded] = React.useState(false);
      const [agentModel, setAgentModel] = React.useState('');
      const [providers, setProviders] = React.useState([]);
      const [saveState, setSaveState] = React.useState('idle'); // idle | saving | saved | error
      const [manualText, setManualText] = React.useState('');
      const timerRef = React.useRef(null);

      React.useEffect(function () {
        let alive = true;
        const controller = new AbortController();
        fetch(CONFIG_URL, { signal: controller.signal })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (data) {
            if (!alive) return;
            setAgentModel(typeof data.agentModel === 'string' ? data.agentModel : '');
            setProviders(Array.isArray(data.providers) ? data.providers : []);
            setLoaded(true);
          })
          .catch(function () {
            if (alive) setLoaded(true); // 拿不到配置也渲染表单（错误态可重试）
          });
        return function () {
          alive = false;
          controller.abort();
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
        };
      }, []);

      function save(value) {
        setSaveState('saving');
        fetch(CONFIG_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentModel: value }),
        })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            setAgentModel(value);
            setSaveState('saved');
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(function () { setSaveState('idle'); }, 2000);
          })
          .catch(function () { setSaveState('error'); });
      }

      // summary：bundle 列表页一行简述（未加载完给占位）
      if (view === 'summary') {
        return h('div', { className: 'dsh-subagent-bridge-cfg-hint' },
          t('configTitle') + ': ' + (loaded ? (agentModel || t('configFollow')) : '…'));
      }

      const knownValues = [];
      providers.forEach(function (p) {
        p.models.forEach(function (m) {
          knownValues.push(p.provider + '/' + m);
        });
      });
      const known = !agentModel || knownValues.indexOf(agentModel) >= 0;
      const saveButton = h('button', {
        type: 'button',
        className: 'dsh-subagent-bridge-copy',
        disabled: saveState === 'saving',
        onClick: function () { save(manualText.trim()); },
      }, saveState === 'saving' ? '…' : t('configSave'));

      // page：完整表单。可用模型来自宿主用户 patch 解析；解析不到（或当前配置
      // 不在列表里）退化为手填输入框。
      return h('div', { className: 'dsh-subagent-bridge-cfg' },
        h('div', { className: 'dsh-subagent-bridge-cfg-title' }, t('configTitle')),
        providers.length > 0 && known
          ? h('div', { className: 'dsh-subagent-bridge-cfg-row' },
              h('select', {
                className: 'dsh-subagent-bridge-cfg-input',
                value: agentModel,
                onChange: function (event) { save(event.target.value); },
              },
                h('option', { key: 'default', value: '' }, t('configFollow')),
                knownValues.map(function (value) {
                  return h('option', { key: value, value: value }, value);
                }),
              ),
            )
          : h('div', { className: 'dsh-subagent-bridge-cfg-row' },
              h('input', {
                className: 'dsh-subagent-bridge-cfg-input',
                placeholder: t('configPlaceholder'),
                value: manualText || agentModel,
                onChange: function (event) { setManualText(event.target.value); },
              }),
              saveButton,
            ),
        h('div', { className: 'dsh-subagent-bridge-cfg-hint' }, t('configHint')),
        saveState === 'saved' ? h('div', { className: 'dsh-subagent-bridge-cfg-saved' }, t('configSaved')) : null,
        saveState === 'error' ? h('div', { className: 'dsh-subagent-bridge-cfg-hint dsh-subagent-bridge-detail-failed' }, t('configError')) : null,
      );
    }

    /* ============================ 插件挂载 ============================ */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        setupLocale(ctx);
        // 侧栏入口图标：id 即 main 面板的 key，侧栏负责按钮外观、选中态和 dispatch。
        ctx.slots.inject(ICON_SLOT, function () {
          return ctx.slots.register({
            name: ICON_SLOT,
            id: PANEL_KEY,
            order: 5,
            label: function () { return localeApi.t('title'); },
          }, PanelIcon);
        });
        // 主区面板：侧栏点击图标后由宿主 dispatch 该 key 渲染，无 Session 绑定。
        ctx.slots.inject(PANEL_SLOT, function () {
          return ctx.slots.register({
            name: PANEL_SLOT,
            key: PANEL_KEY,
          }, PanelMain);
        });
        // 设置：bundle 详情页的配置表单（key = 包名；summary 列表页简述）
        ctx.slots.inject(PLUGIN_CONFIG_SLOT, function () {
          return ctx.slots.register({
            name: PLUGIN_CONFIG_SLOT,
            key: PLUGIN_PACKAGE,
          }, AgentModelConfig);
        });
      },
    };
  },
});
