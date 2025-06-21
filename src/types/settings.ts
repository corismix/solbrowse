export interface FeatureConfig {
  isEnabled: boolean;
  keybind: string;
  position: string;
}

export interface AskBarConfig extends FeatureConfig {
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}

export interface SideBarConfig extends FeatureConfig {
  position: 'left' | 'right';
}

export interface InjectionSettings {
  version: string;
  features: {
    askBar: AskBarConfig;
    sideBar: SideBarConfig;
  };
  provider: string;
  apiKey: string;
  model: string;
  customEndpoint?: string;
  debug: boolean;
}

export interface InjectionConfig {
  iframeUrl: string;
  containerId: string;
  settings: InjectionSettings;
  position?: string;
  existingConversation?: {
    id: string | null;
    messages: import('./messaging').Message[];
    url: string;
    title: string;
    createdAt: number;
    updatedAt: number;
  } | null;
}

export interface BoundsInfo {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface IframeInitData {
  existingConversation: InjectionConfig['existingConversation'];
  position: string;
  url: string;
  title: string;
}
