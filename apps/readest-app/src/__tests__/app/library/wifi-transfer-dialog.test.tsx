import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const listenMock = vi.fn();
let uploadListener: ((event: { payload: unknown }) => void) | undefined;
const unlistenMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: (event: { payload: unknown }) => void) => {
    listenMock(event, handler);
    uploadListener = handler;
    return Promise.resolve(unlistenMock);
  },
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

vi.mock('@/components/Dialog', () => ({
  default: ({
    isOpen,
    title,
    onClose,
    children,
  }: {
    isOpen: boolean;
    title: string;
    onClose: () => void;
    children: React.ReactNode;
  }) =>
    isOpen ? (
      <div role='dialog' aria-label={title}>
        {children}
        <button type='button' aria-label='dialog-close' onClick={onClose}>
          Close
        </button>
      </div>
    ) : null,
}));

import WiFiTransferDialog from '@/app/library/components/WiFiTransferDialog';

describe('WiFiTransferDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadListener = undefined;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'start_wifi_transfer') {
        return Promise.resolve({
          port: 52381,
          urls: ['http://192.168.100.108:52381', 'http://10.0.0.4:52381'],
          supportedExtensions: ['epub', 'pdf', 'txt'],
        });
      }
      return Promise.resolve();
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('starts the server and displays every reachable local URL', async () => {
    render(<WiFiTransferDialog isOpen onClose={vi.fn()} onFilesUploaded={vi.fn()} />);

    expect(await screen.findByText('http://192.168.100.108:52381')).toBeTruthy();
    expect(screen.getByText('http://10.0.0.4:52381')).toBeTruthy();
    expect(screen.getByText(/\.epub, \.pdf, \.txt/)).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith('start_wifi_transfer');
    expect(listenMock).toHaveBeenCalledWith('wifi-transfer-uploaded', expect.any(Function));
  });

  it('forwards uploaded paths into the existing library import callback', async () => {
    const onFilesUploaded = vi.fn().mockResolvedValue(undefined);
    render(<WiFiTransferDialog isOpen onClose={vi.fn()} onFilesUploaded={onFilesUploaded} />);
    await screen.findByText('http://192.168.100.108:52381');

    await act(async () => {
      uploadListener?.({
        payload: {
          files: [
            { path: '/cache/wifi/book.epub', name: 'book.epub', size: 100 },
            { path: '/cache/wifi/notes.txt', name: 'notes.txt', size: 20 },
          ],
        },
      });
    });

    expect(onFilesUploaded).toHaveBeenCalledWith([
      { path: '/cache/wifi/book.epub', name: 'book.epub', size: 100 },
      { path: '/cache/wifi/notes.txt', name: 'notes.txt', size: 20 },
    ]);
  });

  it('serializes upload events so library imports cannot race each other', async () => {
    let finishFirst: (() => void) | undefined;
    const onFilesUploaded = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    render(<WiFiTransferDialog isOpen onClose={vi.fn()} onFilesUploaded={onFilesUploaded} />);
    await screen.findByText('http://192.168.100.108:52381');

    await act(async () => {
      uploadListener?.({
        payload: { files: [{ path: '/cache/wifi/first.epub', name: 'first.epub', size: 10 }] },
      });
      uploadListener?.({
        payload: { files: [{ path: '/cache/wifi/second.epub', name: 'second.epub', size: 10 }] },
      });
      await Promise.resolve();
    });
    expect(onFilesUploaded).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishFirst?.();
      await waitFor(() => expect(onFilesUploaded).toHaveBeenCalledTimes(2));
    });
  });

  it('stops the server when the transfer screen closes', async () => {
    const onClose = vi.fn();
    render(<WiFiTransferDialog isOpen onClose={onClose} onFilesUploaded={vi.fn()} />);
    await screen.findByText('http://192.168.100.108:52381');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('stop_wifi_transfer'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows a useful error when the fixed port cannot be opened', async () => {
    invokeMock.mockRejectedValueOnce('Port 52381 is already in use');

    render(<WiFiTransferDialog isOpen onClose={vi.fn()} onFilesUploaded={vi.fn()} />);

    expect(await screen.findByText('Port 52381 is already in use')).toBeTruthy();
  });
});
