import { useState } from "react";
import { newProject, openProject } from "./core/actions";
import { useSceneStore } from "./core/useSceneStore";
import { Icon, NameDialog } from "./ui";

// Shown while no project is open
export default function Welcome() {
    const store = useSceneStore();
    const [naming, setNaming] = useState(false);

    return (
        <div className="welcome">
            <div className="welcome-card">
                <h1>whiteEditor</h1>
                <p>A scene editor for three.js games. A project is a folder in <b>projects/</b>.</p>

                {store.projects.length > 0 && (
                    <>
                        <h4>Open a project</h4>
                        <div className="welcome-list">
                            {store.projects.map((project) => (
                                <button key={project} className="btn" onClick={() => openProject(project)}>
                                    <Icon name="folder" /> {project}
                                </button>
                            ))}
                        </div>
                    </>
                )}

                <h4>Or start a new one</h4>
                <button className="btn primary" onClick={() => setNaming(true)}>
                    <Icon name="plus" /> New Project
                </button>
                {store.status && <p style={{ marginTop: 14 }}>{store.status}</p>}
            </div>

            {naming && (
                <NameDialog
                    title="New project"
                    confirm="Create"
                    taken={store.projects}
                    onCancel={() => setNaming(false)}
                    onSubmit={(name) => {
                        setNaming(false);
                        newProject(name);
                    }}
                />
            )}
        </div>
    );
}
