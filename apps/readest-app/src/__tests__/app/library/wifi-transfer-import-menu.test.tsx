import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { isOnlineCatalogsAccessible: true } }),
}));

import ImportMenu from '@/app/library/components/ImportMenu';

afterEach(cleanup);

describe('ImportMenu Wi-Fi transfer entry', () => {
  it('keeps existing import actions and opens Wi-Fi Transfer', () => {
    const onFiles = vi.fn();
    const onWifi = vi.fn();
    const setIsDropdownOpen = vi.fn();
    render(
      <ImportMenu
        setIsDropdownOpen={setIsDropdownOpen}
        onImportBooksFromFiles={onFiles}
        onImportBooksFromDirectory={vi.fn()}
        onImportBookFromUrl={vi.fn()}
        onOpenWifiTransfer={onWifi}
        onOpenCatalogManager={vi.fn()}
      />,
    );

    expect(screen.getByText('From Local File')).toBeTruthy();
    expect(screen.getByText('From Directory')).toBeTruthy();
    expect(screen.getByText('From Web URL')).toBeTruthy();

    fireEvent.click(screen.getByText('Wi-Fi Transfer'));

    expect(onWifi).toHaveBeenCalledOnce();
    expect(setIsDropdownOpen).toHaveBeenCalledWith(false);
    expect(onFiles).not.toHaveBeenCalled();
  });
});
