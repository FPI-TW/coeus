import type { AdminUser, BulkUserAction, GrantableScope } from '../useAdmin'
import { t } from '@/i18n'

/** 錯誤物件 → 給人看的訊息。後端 400／409 的 detail 由 requestJSON 放進 message，原樣顯示。 */
export function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : t('admin.users.userText.actionFailedTryAgain')
}

/** 可授予的 scope：以產生的 client（`UserItem.scopes` 的 enum）為準，鍵少一個型別就不過。 */
export const SCOPE_LABELS: Record<GrantableScope, string> = {
  get 'qa_content.read'() { return t('admin.users.userText.viewQAContentQa') },
  get 'ops.operate'() { return t('admin.users.userText.runOperationsActionsOpsOperate') },
  get 'api_clients.manage'() { return t('admin.users.userText.manageApiClientsApiClients') },
}

// 密碼政策與後端 app/services/passwords.py 相同；這裡只是提早提示，後端仍會再驗一次。
export const MIN_PASSWORD = 8

// 帳號規則與後端 app/services/accounts.py 的 `_EMAIL_RE`、`MAX_EMAIL_LENGTH` 相同：Email 格式、只收 ASCII、最多 254 字元。
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/
export const MAX_USERNAME = 254

/** 帳號名稱不合規則時的訊息（文案同後端）；合規回 null。傳入的是已去頭尾空白的值。 */
export function usernameProblem(username: string): string | null {
  return username.length <= MAX_USERNAME && EMAIL_RE.test(username) ? null : t('admin.users.userText.usernameMustBeEmail')
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD) return t('admin.users.userText.passwordsMustBeAtLeast', { MIN_PASSWORD })
  return /[A-Za-z]/.test(password) && /[0-9]/.test(password) ? null : t('admin.users.userText.passwordNeedsLetterAndDigit')
}

export type ConfirmKind = 'disable' | 'demote' | 'logout' | 'delete' | 'resetTotp'

export const CONFIRM_TEXT: Record<ConfirmKind, (u: AdminUser) => { title: string; body: string; label: string }> = {
  disable: u => ({
    title: t('admin.users.userText.disable', { username: u.username }),
    body: t('admin.users.userText.takesEffectImmediatelyEveryDevice'),
    label: t('admin.users.userText.disable2'),
  }),
  demote: u => ({
    title: t('admin.users.userText.removeAdminRoleFrom', { username: u.username }),
    body: t('admin.users.userText.asARegularUserThe'),
    label: t('admin.users.userText.makeRegularUser'),
  }),
  logout: u => ({
    title: t('admin.users.userText.forceSignOutOf', { username: u.username }),
    body: t('admin.users.userText.everySignedInDeviceOf'),
    label: t('admin.users.userText.forceSignOut'),
  }),
  delete: u => ({
    title: t('admin.users.userText.delete', { username: u.username }),
    body: t('admin.users.userText.theAccountIsDisabledAnd'),
    label: t('admin.users.userText.scheduleDeletion'),
  }),
  resetTotp: u => ({
    title: t('admin.users.userText.resetTwoStepVerificationFor', { username: u.username }),
    body: t('admin.users.userText.forSomeoneWhoLostThe'),
    label: t('admin.users.userText.resetTwoStepVerification'),
  }),
}

export const BULK_ACTIONS = ['disable', 'enable', 'logout'] as const satisfies readonly BulkUserAction[]

export const BULK_TEXT: Record<BulkUserAction, { verb: string; body: string }> = {
  disable: { get verb() { return t('admin.users.userText.disable2') }, get body() { return t('admin.users.userText.takesEffectImmediatelyEveryDevice2') } },
  enable: { get verb() { return t('admin.users.userText.enable') }, get body() { return t('admin.users.userText.onceEnabledTheyCanSign') } },
  logout: { get verb() { return t('admin.users.userText.forceSignOut') }, get body() { return t('admin.users.userText.everySignedInDeviceOf2') } },
}
