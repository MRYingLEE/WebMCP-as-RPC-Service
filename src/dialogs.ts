import { Dialog } from '@jupyterlab/apputils';
import { JSONObject } from '@lumino/coreutils';

/**
 * Helpers to report and answer dialogs on behalf of agents.
 */
export namespace Dialogs {
  /**
   * A stable id for a dialog, so that agents can refer to it.
   */
  export function idOf(dialog: Dialog<unknown>): string {
    let id = Private.ids.get(dialog);
    if (!id) {
      id = Private.nextId();
      Private.ids.set(dialog, id);
    }
    return id;
  }

  /**
   * The dialogs of the page, shown or queued.
   */
  export function all(): Dialog<unknown>[] {
    return Dialog.tracker.filter(dialog => !dialog.isDisposed);
  }

  /**
   * The dialogs shown in the page; queued dialogs are shown once the
   * previous ones close.
   */
  export function attached(): Dialog<unknown>[] {
    return Dialog.tracker.filter(
      dialog => dialog.isAttached && !dialog.isDisposed
    );
  }

  /**
   * The labels of the buttons of a dialog, in order.
   */
  export function buttons(dialog: Dialog<unknown>): string[] {
    return Array.from(
      dialog.node.querySelectorAll('.jp-Dialog-footer .jp-Dialog-button')
    ).map(button => (button.textContent ?? '').trim());
  }

  /**
   * Whether a dialog only reports an error, like the ones opened by
   * `showErrorMessage`: a text body and a single button that does not
   * accept. Dialogs with a widget body, such as About, are not errors.
   */
  export function isError(dialog: Dialog<unknown>): boolean {
    const nodes = dialog.node.querySelectorAll(
      '.jp-Dialog-footer .jp-Dialog-button'
    );
    return (
      nodes.length === 1 &&
      nodes[0].classList.contains('jp-mod-reject') &&
      dialog.node.querySelector('.jp-Dialog-content-small') !== null
    );
  }

  /**
   * The title and body text of a dialog.
   */
  export function text(dialog: Dialog<unknown>): {
    title: string;
    body: string;
  } {
    const read = (selector: string): string =>
      (dialog.node.querySelector(selector)?.textContent ?? '').trim();
    const body = read('.jp-Dialog-body');
    // The header renders once the dialog is shown, but a dialog with a text
    // body has the label "<title> <body>".
    const label = dialog.node.ariaLabel ?? '';
    const fallback = label.endsWith(` ${body}`)
      ? label.slice(0, -body.length - 1)
      : '';
    // A title given as an element has no text in the label.
    const title =
      read('.jp-Dialog-header') ||
      (fallback === '[object Object]' ? '' : fallback);
    return { title, body: body.slice(0, 2000) };
  }

  /**
   * Describe a dialog for an agent. Password values are never reported.
   */
  export function describe(dialog: Dialog<unknown>): JSONObject {
    const info: JSONObject = {
      id: idOf(dialog),
      ...text(dialog),
      buttons: buttons(dialog),
      shown: dialog.isAttached
    };
    const input = Array.from(
      dialog.node.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >(
        '.jp-Dialog-body input, .jp-Dialog-body select, .jp-Dialog-body textarea'
      )
    ).find(item => item.type !== 'password');
    if (input instanceof HTMLInputElement && input.type === 'checkbox') {
      info.input = input.checked;
    } else if (input) {
      info.input = input.value;
    }
    return info;
  }

  /**
   * Click a dialog button, given by label (case-insensitive) or index.
   *
   * @returns the label of the clicked button, or an error.
   */
  export function answer(
    dialog: Dialog<unknown>,
    button: string | number
  ): { label: string } | { error: string } {
    const labels = buttons(dialog);
    const index =
      typeof button === 'number'
        ? button
        : labels.findIndex(
            label => label.toLowerCase() === button.trim().toLowerCase()
          );
    // `Dialog.resolve` does not check the index and breaks the dialog when
    // it is out of range.
    if (!Number.isInteger(index) || index < 0 || index >= labels.length) {
      return {
        error: `No button ${JSON.stringify(button)} in the dialog. Buttons: ${JSON.stringify(labels)}.`
      };
    }
    dialog.resolve(index);
    if (!dialog.isDisposed) {
      return {
        error:
          'The dialog did not close, for example because its input is not valid.'
      };
    }
    return { label: labels[index] };
  }
}

/**
 * The namespace for module private data.
 */
namespace Private {
  export const ids = new WeakMap<Dialog<unknown>, string>();

  let counter = 0;

  /**
   * A new dialog id.
   */
  export function nextId(): string {
    return `dialog-${++counter}`;
  }
}
