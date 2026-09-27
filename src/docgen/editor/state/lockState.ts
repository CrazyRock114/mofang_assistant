import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export interface LockState {
  textLocked: boolean;  // Lock text editing
  positionLocked: boolean;  // Lock position (prevent drag/reorder)
}

const lockStateKey = new PluginKey<LockState>('lockState');

export const LockExtension = Extension.create({
  name: 'lockExtension',

  addOptions() {
    return {
      textLocked: false,
      positionLocked: false,
    };
  },

  addProseMirrorPlugins() {
    const extension = this;

    return [
      new Plugin({
        key: lockStateKey,
        state: {
          init() {
            return {
              textLocked: extension.options.textLocked,
              positionLocked: extension.options.positionLocked,
            };
          },
          apply(tr, value) {
            const meta = tr.getMeta(lockStateKey);
            if (meta) {
              return { ...value, ...meta };
            }
            return value;
          },
        },
        props: {
          editable(state) {
            const lockState = lockStateKey.getState(state);
            if (lockState?.textLocked) {
              return false;
            }
            return true;
          },
          // D6 修复：positionLocked enforcement
          handleDOMEvents: {
            dragstart(view, event) {
              const lockState = lockStateKey.getState(view.state);
              if (lockState?.positionLocked) {
                event.preventDefault();
                return true;
              }
              return false;
            },
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      setLockState: (state: Partial<LockState>) => ({ tr, dispatch }) => {
        if (dispatch) {
          tr.setMeta(lockStateKey, state);
        }
        return true;
      },
      lockText: () => ({ commands }) => {
        return commands.setLockState({ textLocked: true });
      },
      unlockText: () => ({ commands }) => {
        return commands.setLockState({ textLocked: false });
      },
      lockPosition: () => ({ commands }) => {
        return commands.setLockState({ positionLocked: true });
      },
      unlockPosition: () => ({ commands }) => {
        return commands.setLockState({ positionLocked: false });
      },
    };
  },
});

/**
 * Get current lock state from editor
 */
export function getLockState(editor: any): LockState {
  const state = lockStateKey.getState(editor.state);
  return state || { textLocked: false, positionLocked: false };
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    lockExtension: {
      setLockState: (state: Partial<LockState>) => ReturnType;
      lockText: () => ReturnType;
      unlockText: () => ReturnType;
      lockPosition: () => ReturnType;
      unlockPosition: () => ReturnType;
    };
  }
}
