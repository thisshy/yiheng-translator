# Translation workspace

Click the toolbar icon to open the workspace in a browser tab. Clicking again in the same window reuses the workspace tab. Paste text into the source box and click **翻译文字**, or press **Ctrl+Enter** (Command+Enter on macOS). Use **打开翻译工作台** from the context menu to bring selected text into the original pane. Opening the workspace and importing selections leave the text ready for review before translation.

- **A− / A+** changes source and result text between 14 and 24 px (default 16). Settings also offer system, Microsoft YaHei and SimSun fonts, plus system/light/dark appearance. These preferences persist in extension configuration.
- Source and result sit side by side on wide screens and stack on narrow screens. Copy is below the result. History starts collapsed.
- Both text boxes offer local system speech with a stop button. Source and result playback are mutually exclusive. A matching language voice must be installed in the system; speech does not call a model or network TTS service.
- Paste a screenshot with **Ctrl+V**, choose a PNG/JPEG/WebP file, or use **截取网页** to capture the visible webpage. Images up to 5 MiB appear as a preview and are submitted only after clicking **翻译图片**. Image translation uses the existing ChatGPT OAuth service. Other services are rejected before dispatch.
- Image translation recognizes the original text and translates it in the same request. The source box displays the recognized text and can read it aloud after generation; the result box reads the translation. Optional instructions live in a separate collapsed field, and are never used as the recognized original. Both texts are restored with the image draft. Removing the image keeps its recognized source as ordinary editable text.
- Explain, polish and summarize use the same result area. Conversation, PDF, subtitle files, shortcuts and configuration import/export remain accessible through **更多工具**.
- Text translation uses `sidePanel.service` and `sidePanel.targetLanguage`, falling back to the main configuration. The page tab displays and edits the separate main service/language used for webpage translation (site rules may override it).
- Current text, image attachment and result are restored after closing/reopening the workspace during the browser session through `storage.session`. Completed text translation history remains in local storage; screenshots are not added to permanent history. Chat transcripts remain in memory.
- **停止** aborts the active request and keeps partial output. Started streaming requests are never silently retried as another complete request. Only a model error offers a model retry; clipboard or settings errors do not resubmit text.

The toolbar action opens `translator.html`. Webpage controls and screenshots use the opener tab. Reload the unpacked extension once after updating its installed files.

Relevant checks: `npm run typecheck`, the shared configuration and assistant tests, `tests/ui/sidepanel.test.tsx`, `tests/background/chatgpt-oauth-service.test.ts`, and `npm run build`.
