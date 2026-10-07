import { Checkbox, Text, tokens, makeStyles } from '@fluentui/react-components';
import { IMAGE_BUILD_CHECKLIST, type ImageBuildChecklistState } from '@avdmgr/shared';

const useStyles = makeStyles({
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
  },
  source: {
    color: tokens.colorNeutralForeground3,
    marginLeft: '28px',
  },
});

export interface ImageBuildChecklistProps {
  checklist: ImageBuildChecklistState;
  /** Disabled while a build isn't actually at checklist_gate, or while a toggle is in flight. */
  disabled: boolean;
  onToggle: (itemId: string, checked: boolean) => void;
}

/**
 * AM-27 (M4-S2) — renders the fixed, build-manual-sourced checklist
 * (IMAGE_BUILD_CHECKLIST, @avdmgr/shared) the operator must tick before
 * advancing past checklist_gate. Every item cites the exact
 * The golden-image runbook section it came from, so the operator
 * can go verify it in-guest rather than trusting a bare label. This is a UI
 * convenience only — the server independently re-validates every item is
 * ticked before allowing POST .../advance (see
 * app/api/src/lib/imageBuildChecklist.ts#allRequiredChecklistItemsChecked).
 */
export default function ImageBuildChecklist({ checklist, disabled, onToggle }: ImageBuildChecklistProps) {
  const styles = useStyles();
  return (
    <div className={styles.list}>
      {IMAGE_BUILD_CHECKLIST.map((item) => (
        <div key={item.id} className={styles.item}>
          <Checkbox
            checked={checklist[item.id] === true}
            disabled={disabled}
            onChange={(_event, data) => onToggle(item.id, data.checked === true)}
            label={item.label}
          />
          <Text size={200} className={styles.source}>
            {item.source}
          </Text>
        </div>
      ))}
    </div>
  );
}
