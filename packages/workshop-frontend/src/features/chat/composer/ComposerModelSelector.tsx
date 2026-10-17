import { DropdownMenu } from "@cloudflare/kumo";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";

/**
 * The composer's model, or null for "No agent". `name` labels it when `models` doesn't offer it,
 * such as a hidden model an existing chat last ran on; the raw id is shown when that is absent too.
 */
export type SelectedModel = { id: string; name?: string } | null;

type ComposerModelSelectorProps = {
  models: readonly AiChatAuthorInfo[];
  selectedModel: SelectedModel;
  onModelChange: (modelId: string | null) => void;
};

export const ComposerModelSelector = ({
  models,
  selectedModel,
  onModelChange,
}: ComposerModelSelectorProps) => {
  const selectedModelLabel = selectedModel == null
    ? "No agent"
    : models.find((model) => model.id === selectedModel.id)?.name ??
      selectedModel.name ?? selectedModel.id;

  return (
    <div className="flex flex-wrap items-center gap-2">
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            className="group inline-flex min-h-11 min-w-0 max-w-[110px] cursor-pointer items-center gap-1.5 rounded-lg px-2 text-base leading-6 text-kumo-default transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:text-kumo-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current active:scale-[0.97] data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default sm:max-w-[180px]"
            aria-label="Select model"
          >
            <span className="min-w-0 truncate">{selectedModelLabel}</span>
            <CaretDown
              size={12}
              weight="bold"
              className="flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180"
            />
          </button>
        }
      />
      <DropdownMenu.Content className="themed-floating-shadow-lg !z-[1100] !min-w-[190px] rounded-2xl border border-kumo-line/70 bg-kumo-base p-1">
        {models.map((model) => {
          const active = selectedModel?.id === model.id;
          return (
            <DropdownMenu.Item
              key={model.id}
              onClick={() => onModelChange(model.id)}
              className="!h-auto min-h-11 rounded-xl !px-2 !py-2 text-base leading-6 font-normal text-kumo-default transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default"
            >
              <span className="min-w-0 flex-1 truncate">{model.name}</span>
              {active && (
                <Check
                  size={12}
                  weight="bold"
                  className="ml-3 flex-shrink-0 text-kumo-inactive"
                />
              )}
            </DropdownMenu.Item>
          );
        })}
        <div className="my-1 border-t border-kumo-line/70" />
        <DropdownMenu.Item
          onClick={() => onModelChange(null)}
          className="!h-auto min-h-11 rounded-xl !px-2 !py-2 text-base leading-6 font-normal text-kumo-default transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default"
        >
          <span className="min-w-0 flex-1 truncate">No agent</span>
          {selectedModel == null && (
            <Check
              size={12}
              weight="bold"
              className="ml-3 flex-shrink-0 text-kumo-inactive"
            />
          )}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
    {selectedModel?.id.startsWith('chatgpt:') && <a href="https://chatgpt.com/settings/usage"
      target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-xs text-kumo-default underline">
      Using ChatGPT plan · Manage usage
    </a>}
    </div>
  );
};
