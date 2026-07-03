'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { MdWifi } from 'react-icons/md';
import Dialog from '@/components/Dialog';
import { useTranslation } from '@/hooks/useTranslation';

interface WifiTransferInfo {
  port: number;
  urls: string[];
  supportedExtensions: string[];
}

export interface WifiTransferFile {
  path: string;
  name: string;
  size: number;
}

interface WifiTransferUploadedEvent {
  files: WifiTransferFile[];
}

interface WiFiTransferDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onFilesUploaded: (files: WifiTransferFile[]) => Promise<void>;
}

const getErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;

const WiFiTransferDialog: React.FC<WiFiTransferDialogProps> = ({
  isOpen,
  onClose,
  onFilesUploaded,
}) => {
  const _ = useTranslation();
  const [info, setInfo] = useState<WifiTransferInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const onFilesUploadedRef = useRef(onFilesUploaded);
  const translationRef = useRef(_);
  const importQueueRef = useRef(Promise.resolve());
  onFilesUploadedRef.current = onFilesUploaded;
  translationRef.current = _;

  const stopServer = useCallback(async () => {
    await invoke('stop_wifi_transfer').catch(() => {});
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    setInfo(null);
    setError(null);
    setImporting(false);

    void listen<WifiTransferUploadedEvent>('wifi-transfer-uploaded', (event) => {
      if (disposed || !Array.isArray(event.payload?.files)) return;
      setImporting(true);
      const queuedImport = importQueueRef.current.then(() =>
        onFilesUploadedRef.current(event.payload.files),
      );
      const queueTail = queuedImport.catch(() => {});
      importQueueRef.current = queueTail;
      void queuedImport
        .catch((uploadError) => {
          if (!disposed) {
            setError(
              getErrorMessage(
                uploadError,
                translationRef.current('Could not import uploaded files'),
              ),
            );
          }
        })
        .finally(() => {
          if (!disposed && importQueueRef.current === queueTail) setImporting(false);
        });
    })
      .then((removeListener) => {
        if (disposed) {
          removeListener();
          return null;
        }
        unlisten = removeListener;
        return invoke<WifiTransferInfo>('start_wifi_transfer');
      })
      .then((transferInfo) => {
        if (!transferInfo) return;
        if (disposed) void stopServer();
        else setInfo(transferInfo);
      })
      .catch((startError) => {
        if (!disposed) {
          setError(
            getErrorMessage(startError, translationRef.current('Could not start Wi-Fi transfer')),
          );
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
      void stopServer();
    };
  }, [isOpen, stopServer]);

  const handleClose = () => {
    void stopServer().finally(onClose);
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={handleClose}
      title={_('Wi-Fi Transfer')}
      boxClassName='sm:!h-auto sm:!max-h-[85vh] sm:!w-[560px] sm:!max-w-[560px]'
    >
      <div className='flex flex-col gap-4 px-1 pb-6 pt-2 sm:px-2'>
        <div className='flex items-start gap-3'>
          <span className='bg-success/15 text-success eink-bordered flex h-10 w-10 shrink-0 items-center justify-center rounded-full'>
            <MdWifi className='h-5 w-5' />
          </span>
          <div>
            <p className='font-medium'>{_('Send books over your local Wi-Fi')}</p>
            <p className='text-base-content/60 mt-1 text-sm leading-relaxed'>
              {_('Open one of these addresses in a browser connected to the same network.')}
            </p>
          </div>
        </div>

        {!info && !error && (
          <div className='flex items-center gap-2 py-4'>
            <span className='loading loading-spinner loading-sm' />
            <span className='text-base-content/60 text-sm'>{_('Starting transfer server…')}</span>
          </div>
        )}

        {info && (
          <div className='flex flex-col gap-3'>
            <div className='bg-base-200 eink-bordered rounded-xl border border-transparent p-3'>
              <p className='text-base-content/60 mb-2 text-xs font-medium uppercase tracking-wide'>
                {_('Available addresses')}
              </p>
              <div className='flex flex-col gap-2'>
                {info.urls.map((url) => (
                  <a
                    key={url}
                    href={url}
                    target='_blank'
                    rel='noreferrer'
                    className='link link-primary break-all font-mono text-sm'
                  >
                    {url}
                  </a>
                ))}
              </div>
            </div>
            <p className='text-base-content/60 text-sm'>
              {_('Supported formats')}:{' '}
              {info.supportedExtensions.map((ext) => `.${ext}`).join(', ')}
            </p>
            <p className='text-base-content/60 text-sm leading-relaxed'>
              {_(
                'Keep this screen open during transfer. The server stops as soon as you close it.',
              )}
            </p>
            {importing && (
              <p className='flex items-center gap-2 text-sm'>
                <span className='loading loading-spinner loading-xs' />
                {_('Adding uploaded files to your bookshelf…')}
              </p>
            )}
          </div>
        )}

        {error && <p className='text-error text-sm leading-relaxed'>{error}</p>}

        <div className='flex justify-end pt-1'>
          <button type='button' className='btn btn-contrast btn-sm' onClick={handleClose}>
            {_('Close')}
          </button>
        </div>
      </div>
    </Dialog>
  );
};

export default WiFiTransferDialog;
