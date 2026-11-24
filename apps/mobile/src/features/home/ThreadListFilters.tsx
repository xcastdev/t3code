import { useGT } from "gt-react-native";
import { Pressable, ScrollView } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  HomeListFilterMenuEnvironment,
  HomeListFilterMenuProject,
} from "./home-list-filter-menu";

export function ThreadListFilters(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  /** Threads also filter by project; agents have none. */
  readonly project?: {
    readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
    readonly selectedProjectKey: string | null;
    readonly onProjectChange: (projectKey: string | null) => void;
  };
  /** List padding the scroller bleeds through so pills start where row content does. */
  readonly gutter: number;
}) {
  const gt = useGT();
  const project = props.project;
  const selectedEnvironment = props.environments.find(
    (environment) => environment.environmentId === props.selectedEnvironmentId,
  );
  const selectedProject = project?.projects.find(
    (candidate) => candidate.key === project.selectedProjectKey,
  );
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginHorizontal: -props.gutter, overflow: "visible" }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 2, paddingBottom: 10, gap: 8 }}
    >
      <ListFilterMenu
        label={selectedEnvironment?.label ?? gt("All environments")}
        accessibilityLabel={
          project ? gt("Filter threads by environment") : gt("Filter agents by environment")
        }
        active={selectedEnvironment !== undefined}
        actions={[
          {
            id: "all",
            title: gt("All environments"),
            state: props.selectedEnvironmentId === null ? "on" : "off",
          },
          ...props.environments.map((environment) => ({
            id: JSON.stringify(environment.environmentId),
            title: environment.label,
            state:
              environment.environmentId === props.selectedEnvironmentId
                ? ("on" as const)
                : ("off" as const),
          })),
        ]}
        onSelect={(id) => {
          if (id === "all") props.onEnvironmentChange(null);
          else {
            const environment = props.environments.find(
              (candidate) => JSON.stringify(candidate.environmentId) === id,
            );
            if (environment) props.onEnvironmentChange(environment.environmentId);
          }
        }}
      />
      {project ? (
        <ListFilterMenu
          label={selectedProject?.label ?? gt("All projects")}
          accessibilityLabel={gt("Filter threads by project")}
          active={selectedProject !== undefined}
          actions={[
            {
              id: "all",
              title: gt("All projects"),
              state: project.selectedProjectKey === null ? "on" : "off",
            },
            ...project.projects.map((candidate) => ({
              id: JSON.stringify(candidate.key),
              title: candidate.label,
              state:
                candidate.key === project.selectedProjectKey ? ("on" as const) : ("off" as const),
            })),
          ]}
          onSelect={(id) => {
            if (id === "all") project.onProjectChange(null);
            else {
              const selected = project.projects.find(
                (candidate) => JSON.stringify(candidate.key) === id,
              );
              if (selected) project.onProjectChange(selected.key);
            }
          }}
        />
      ) : null}
      {props.selectedEnvironmentId !== null || (project?.selectedProjectKey ?? null) !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={project ? gt("Reset thread filters") : gt("Reset agent filters")}
          className="h-8 w-8 items-center justify-center"
          onPress={() => {
            props.onEnvironmentChange(null);
            project?.onProjectChange(null);
          }}
        >
          <SymbolView name="xmark.circle.fill" size={18} tintColorClassName="accent-icon-muted" />
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
