import { useEffect, useState } from "preact/hooks";
import browser from "webextension-polyfill";
import { Button, Field, Select } from "../shared/components";

// Keep credentials separate from translation config, exports and tab messages.
export const SPEECH_CONFIG_KEY = "doubaoSpeechConfig";
export interface SpeechConfig {
  provider: "system" | "doubao";
  apiKey: string;
  speaker: string;
}
export const DEFAULT_SPEECH_CONFIG: SpeechConfig = {
  provider: "system",
  apiKey: "",
  speaker: "zh_female_vv_uranus_bigtts",
};

function normalize(value: unknown): SpeechConfig {
  const config = value as Partial<SpeechConfig> | undefined;
  return {
    provider: config?.provider === "doubao" ? "doubao" : "system",
    apiKey: typeof config?.apiKey === "string" ? config.apiKey : "",
    speaker:
      typeof config?.speaker === "string" && config.speaker.trim()
        ? config.speaker.trim()
        : DEFAULT_SPEECH_CONFIG.speaker,
  };
}

export function useSpeechConfig() {
  const [config, setConfig] = useState(DEFAULT_SPEECH_CONFIG);
  useEffect(() => {
    let alive = true;
    void browser.storage.local
      .get(SPEECH_CONFIG_KEY)
      .then((stored) => {
        if (alive) setConfig(normalize(stored?.[SPEECH_CONFIG_KEY]));
      })
      .catch(() => undefined);
    const changed = (
      changes: Record<string, browser.Storage.StorageChange>,
      area: string,
    ) => {
      if (area === "local" && changes[SPEECH_CONFIG_KEY]) {
        setConfig(normalize(changes[SPEECH_CONFIG_KEY].newValue));
      }
    };
    browser.storage.onChanged.addListener(changed);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(changed);
    };
  }, []);
  async function save(patch: Partial<SpeechConfig>): Promise<void> {
    const next = normalize({ ...config, ...patch });
    await browser.storage.local.set({ [SPEECH_CONFIG_KEY]: next });
    setConfig(next);
  }
  return { config, save };
}

export function SpeechSettings() {
  const { config, save } = useSpeechConfig();
  const [key, setKey] = useState("");
  const [notice, setNotice] = useState("");
  async function update(patch: Partial<SpeechConfig>) {
    try {
      await save(patch);
      setNotice("朗读设置已保存");
    } catch {
      setNotice("朗读设置保存失败，请重试");
    }
  }
  return (
    <fieldset class="side-speech-settings">
      <legend>朗读设置</legend>
      <Field label="朗读声音来源" htmlFor="speech-provider">
        <Select
          id="speech-provider"
          value={config.provider}
          options={[
            { value: "system", label: "系统语音" },
            { value: "doubao", label: "豆包语音 2.0（AI 朗读）" },
          ]}
          onChange={(provider) =>
            void update({ provider: provider as SpeechConfig["provider"] })
          }
        />
      </Field>
      {config.provider === "doubao" && (
        <>
          <Field
            label="豆包语音 API Key"
            htmlFor="speech-api-key"
            hint={
              config.apiKey
                ? "已配置，留空保留现有凭证。"
                : "填入火山引擎豆包语音控制台的 API Key。"
            }
          >
            <input
              id="speech-api-key"
              type="password"
              autoComplete="off"
              value={key}
              placeholder={config.apiKey ? "已配置" : "请输入 API Key"}
              onInput={(e) => setKey(e.currentTarget.value)}
            />
            <Button
              disabled={!key.trim()}
              onClick={() => {
                void update({ apiKey: key.trim() });
                setKey("");
              }}
            >
              保存凭证
            </Button>
          </Field>
          <Field
            label="豆包音色 ID"
            htmlFor="speech-speaker"
            hint="默认使用豆包 VV 音色，支持中英文朗读。"
          >
            <input
              id="speech-speaker"
              value={config.speaker}
              onChange={(e) => void update({ speaker: e.currentTarget.value })}
            />
          </Field>
        </>
      )}
      {notice && <small role="status">{notice}</small>}
    </fieldset>
  );
}
